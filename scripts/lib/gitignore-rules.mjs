// Reads the repository's own ".gitignore" files and answers the one question
// "git check-ignore" answers: would "git add" exclude this repository-relative
// path?
//
// It exists because a clean "git archive" export has no ".git" directory, so
// "git check-ignore --no-index" cannot run there, and the review service
// mandates a clean archive export. The hygiene test uses git itself whenever a
// work tree is present, and falls back to this module otherwise; the two are
// held together by a cross-check over every path in the tree (see
// "scripts/repo_hygiene.test.mjs", test "the ignore rules read the same in this
// tree and in git").
//
// Supported semantics are git's, deliberately limited to what ".gitignore"
// defines: whole-line comments, blank lines, "!" negation, "\" escaping, a
// trailing "/" for directories, a leading or embedded "/" for anchoring, "*",
// "?", "[...]" character classes (including "[!...]" and "[^...]" negation,
// ranges and "[:name:]" classes) and "**". A pattern's own file position is
// fixed by where it was read from, and a pattern without a "/" matches the
// basename at any depth under that directory. A rule that excludes a directory
// excludes everything below it, whatever its spelling: the walk never descends
// past an ancestor a positive rule names, whether that rule is "foo/", "foo",
// "*.log", "a/*" or "**/cache".
//
// One documented divergence, measured against git 2.50.1:
//
//   * "git check-ignore" answers "foo/" as ignored under the pattern "foo/**",
//     while "git add" does not exclude the directory "foo" itself: only what is
//     below it. This reader follows "git add", because excluding what would be
//     committed is the question the hygiene gate asks.
//
// Two shapes that look like divergences and are not, both measured against git
// 2.50.1:
//
//   * a path under an excluded directory cannot be re-included, not even by a
//     ".gitignore" inside that directory: git never descends into it, and
//     neither does this walk. With "logs/" in the root ignore file and
//     "logs/.gitignore" holding "!keep.txt", "git check-ignore" and this reader
//     both still answer "logs/keep.txt" ignored.
//   * a "[" that never closes, or that closes to an empty class ("a[]b"), makes
//     git stop reading the pattern at all, so such a pattern excludes nothing.
//     This reader answers that the same way, and so does a "-" that opens a
//     class body: it is a member, and "[!-a]" excludes what is neither "-" nor
//     "a" here exactly as it does in wildmatch.

import fs from "node:fs";
import path from "node:path";

/**
 * Splits one ".gitignore" line into a pattern string, or null when the line
 * carries no pattern (blank or comment).
 */
export function parseIgnoreLine(rawLine) {
  let line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  // A trailing space is not part of the pattern unless it is escaped.
  while (line.endsWith(" ") && !line.endsWith("\\ ")) line = line.slice(0, -1);
  if (line === "") return null;
  if (line.startsWith("#")) return null;
  return line;
}

/**
 * Compiles one ".gitignore" pattern into a matcher over a path that is already
 * relative to the directory holding the ".gitignore" file.
 *
 * `directoryOnly` mirrors git's "the pattern ends with a slash" rule; callers
 * pass whether the path being tested names a directory.
 */
export function compileIgnorePattern(pattern) {
  const directoryOnly = pattern.endsWith("/");
  const body = directoryOnly ? stripTrailingSlashes(pattern) : pattern;
  if (body === "") return null;

  let negated = false;
  let remainder = body;
  if (remainder.startsWith("!") && remainder.length > 1) {
    negated = true;
    remainder = remainder.slice(1);
  }

  // A leading slash anchors the pattern and is not part of it.
  const leadingSlash = remainder.startsWith("/");
  if (leadingSlash) remainder = remainder.slice(1);
  if (remainder === "") return null;

  // A slash anywhere but at the end anchors the pattern to the ".gitignore"
  // file's directory; without one it matches a basename at any depth, which is
  // expressed as an optional leading path. A leading "**/" is unanchored in the
  // same way, so it takes the same prefix and writes its own separators.
  const anchored = leadingSlash || remainder.includes("/");
  const segments = remainder.split("/");
  const leadingWildcard = segments[0] === "**" && segments.length > 1;
  const rest = leadingWildcard ? segments.slice(1) : segments;
  const prefix = !anchored || leadingWildcard ? "(?:.*/)?" : "";

  const source = ["(?:"];
  // True while the last emitted segment already ended with the separator the
  // next one needs, so that separator must not be written twice.
  let separatorWritten = false;
  rest.forEach((segment, index) => {
    if (segment === "**") {
      if (rest.length === 1) {
        // A sole "**" matches every path, the root included.
        source.push(".*");
        separatorWritten = false;
      } else if (index === rest.length - 1) {
        // A trailing "**" names what is inside the directory before it, never
        // that directory or the pattern's own prefix, so it requires at least
        // one name after its separator.
        source.push("/[^/]+(?:/.*)?");
        separatorWritten = false;
      } else {
        // Between two other segments a "**" spans zero or more whole
        // directories, so "a/**/b" matches "a/b" as well as "a/x/y/b".
        source.push("(?:/[^/]+)*/");
        separatorWritten = true;
      }
      return;
    }
    if (index > 0 && !separatorWritten) source.push("/");
    source.push(translateSegment(segment));
    separatorWritten = false;
  });
  source.push(")");

  return {
    directoryOnly,
    negated,
    pattern,
    anchored,
    regex: new RegExp(`^${prefix}${source.join("")}$`),
  };
}

function stripTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

// The characters a bracket expression can add to a regular-expression class
// without escaping: "]", "\" and "^" as members. A lone "-" is escaped too,
// because it reaches this function only as a literal member — a range is
// parsed into one multi-character part and is emitted without it — and an
// unescaped one directly after the separator a negated class opens with would
// read as a range instead: "[!-a]" excludes neither "-" nor "a", never every
// character from "/" to "a".
const LITERAL_CLASS_CHARACTERS = /[\\\]^-]/;

// The POSIX class names git's wildmatch accepts, with the ranges each stands
// for. They are expanded here rather than passed through, so the reader does
// not depend on the regular expression engine's locale.
const POSIX_CLASSES = {
  alnum: "0-9A-Za-z",
  alpha: "A-Za-z",
  ascii: "\\x00-\\x7f",
  blank: " \\t",
  cntrl: "\\x00-\\x1f\\x7f",
  digit: "0-9",
  graph: "!-~",
  lower: "a-z",
  print: " -~",
  punct: "!-/:-@\\[-`{-~",
  space: " \\t\\r\\n\\v\\f",
  upper: "A-Z",
  word: "0-9A-Za-z_",
  xdigit: "0-9A-Fa-f",
};

function translateSegment(segment) {
  let out = "";
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index];
    if (character === "\\") {
      index += 1;
      out += index < segment.length ? escapeRegExp(segment[index]) : "\\\\";
      continue;
    }
    if (character === "*") {
      out += "[^/]*";
      continue;
    }
    if (character === "?") {
      out += "[^/]";
      continue;
    }
    if (character === "[") {
      const parsed = parseBracketExpression(segment, index);
      if (parsed === null) {
        // A "[" that never closes, or that closes to an empty class, makes git
        // stop reading the pattern at all, so the pattern matches nothing. It
        // is never an ordinary character: "a[" does not match the file "a[".
        out = "(?!)";
        index = segment.length;
        continue;
      }
      out += parsed.source;
      index = parsed.end;
      continue;
    }
    out += escapeRegExp(character);
  }
  return out;
}

/**
 * Reads the bracket expression that starts at `start`, the way wildmatch reads
 * it: "[!" or "[^" negates the set, a "]" directly after the opening (or after
 * the negation) is a member and not the close, "-" is a range unless it is the
 * last member, and "[:name:]" is a POSIX class. Returns null when the
 * expression is never closed, which git treats as a literal "[".
 */
function parseBracketExpression(segment, start) {
  let index = start + 1;
  let negated = false;
  if (segment[index] === "!" || segment[index] === "^") {
    negated = true;
    index += 1;
  }
  // The member of a class is terminated by "]", except when the class never
  // closes: git then treats the "]" as an ordinary member, and a class such as
  // "[a-]" is the range from "a" to "]" rather than the letters "a" and "-".
  const bodyEnd = segment.lastIndexOf("]");
  const parts = [];
  // The member just read. It stays pending because the next character can turn
  // it into the start of a range, and a range replaces its first character.
  let pending = null;
  let openRange = false; // True while "pending" is the start of a "x-y" range.
  let first = true;
  for (; index < segment.length; index += 1) {
    const character = segment[index];
    if (character === "]" && !first && index === bodyEnd) break;
    first = false;
    if (character === "[" && segment[index + 1] === ":") {
      const close = segment.indexOf(":]", index + 2);
      if (close !== -1) {
        const name = segment.slice(index + 2, close).toLowerCase();
        const expansion = POSIX_CLASSES[name];
        if (expansion !== undefined) {
          if (pending !== null) parts.push(pending);
          pending = null;
          openRange = false;
          parts.push(expansion);
          // The loop advances once more, which lands on the "]" that closes
          // "[:name:]".
          index = close + 1;
          continue;
        }
      }
    }
    // "-" is a range only between two characters; at the end of the class, or
    // right after another "-", it is an ordinary member.
    if (
      character === "-"
      && pending !== null
      && !openRange
      && index + 1 < segment.length
      && !(segment[index + 1] === "]" && index + 1 === bodyEnd)
    ) {
      pending = `${pending}-${segment[index + 1]}`;
      openRange = true;
      // The range consumed the character after the "-" as well.
      index += 1;
      continue;
    }
    if (pending !== null) parts.push(pending);
    pending = character;
    openRange = false;
  }
  if (index >= segment.length) return null;
  if (pending !== null) parts.push(pending);
  if (parts.length === 0) return null;

  const emitted = parts
    .map((part) => (part.length > 1 ? part : escapeClassCharacter(part)))
    .join("");
  // A negated class excludes the separator as well: a class is one path
  // segment, so it can never name "/".
  return {
    end: index,
    source: negated ? `[^/${emitted}]` : `[${emitted}]`,
  };
}

function escapeClassCharacter(character) {
  return LITERAL_CLASS_CHARACTERS.test(character) ? `\\${character}` : character;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Returns every ".gitignore" below `directory`, repository-relative to it. */
export function findIgnoreFiles(directory) {
  const found = [];
  const visit = (relative) => {
    const absolute = path.join(directory, relative);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      if (entry.isDirectory()) visit(path.join(relative, entry.name));
      else if (entry.name === ".gitignore") found.push(relative);
    }
  };
  visit("");
  return found.sort();
}

/** Compiled patterns of one ".gitignore", shallowest file first. */
function readIgnoreFile(directory, relativeDirectory) {
  if (relativeDirectory !== "" && relativeDirectory !== "." && !directoryExists(directory, relativeDirectory)) {
    return null;
  }
  const file = path.join(directory, relativeDirectory, ".gitignore");
  if (!fs.existsSync(file)) return null;
  const patterns = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const parsed = parseIgnoreLine(line);
    if (parsed === null) continue;
    const compiled = compileIgnorePattern(parsed);
    if (compiled !== null) patterns.push(compiled);
  }
  return patterns;
}

function directoryExists(directory, relative) {
  try {
    return fs.statSync(path.join(directory, relative)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The ignore rules of one exported tree, without git.
 *
 * `directory` is the tree's root. Every answer is relative to it and uses "/"
 * separators, exactly like the paths "git check-ignore" is given.
 */
export function loadIgnoreRules(directory) {
  const cache = new Map();
  const rulesAt = (relativeDirectory) => {
    if (!cache.has(relativeDirectory)) {
      cache.set(relativeDirectory, readIgnoreFile(directory, relativeDirectory) ?? []);
    }
    return cache.get(relativeDirectory);
  };

  // Every ".gitignore" the walk can reach is read once, here, so an answer does
  // not depend on the tree still being on disk: an export can be deleted after
  // it was read, and the reader must keep answering from what it read.
  for (const relativeFile of findIgnoreFiles(directory)) {
    rulesAt(relativeFile === ".gitignore" ? "" : relativeFile.slice(0, -"/.gitignore".length));
  }

  // Shallowest directory first: every ".gitignore" is a block of rules that
  // applies from its own directory downwards, and the last matching rule wins.
  const accumulated = (segments, includeLeafDirectory) => {
    const rules = [];
    const depth = segments.length;
    const last = includeLeafDirectory ? depth : depth - 1;
    for (let index = 0; index <= last; index += 1) {
      const relativeDirectory = segments.slice(0, index).join("/");
      for (const rule of rulesAt(relativeDirectory)) {
        rules.push({ relativeDirectory, rule });
      }
    }
    return rules;
  };

  // `depth` is how many leading segments form the path the rule is being
  // applied to, which is not always the whole path: a directory rule is
  // satisfied by naming an ancestor directory ("node_modules/" ignores
  // "node_modules/pkg/index.js" by ignoring "node_modules"), while a rule that
  // is not directory-only names one basename and so is only ever a verdict
  // about the whole path. `directory` says whether that path is being asked
  // about as a directory, which is what a directory rule requires. The answer
  // names whether the last matching rule was a negation, because the walk
  // cannot stop on a "!".
  const verdictAt = (rules, segments, depth, directory) => {
    let verdict = false;
    let lastRuleNegated = false;
    for (const { relativeDirectory, rule } of rules) {
      // A "foo/" rule names a directory that is never a plain file, so it says
      // nothing about a path whose last segment is a file.
      if (rule.directoryOnly && depth === segments.length && !directory) continue;
      const prefix = relativeDirectory === "" ? "" : `${relativeDirectory}/`;
      const relative = segments.slice(0, depth).join("/");
      if (prefix !== "" && !relative.startsWith(prefix)) continue;
      const candidate = prefix === "" ? relative : relative.slice(prefix.length);
      if (rule.regex.test(candidate)) {
        verdict = !rule.negated;
        lastRuleNegated = rule.negated;
      }
    }
    return { ignored: verdict, lastRuleNegated };
  };

  return {
    root: directory,
    /** True when "git add" would exclude `relativePath` from `directory`. */
    isIgnored(relativePath, isDirectory = false) {
      const segments = relativePath.split("/").filter((segment) => segment !== "" && segment !== ".");
      if (segments.length === 0) return false;
      // A path under an ignored directory is ignored whatever its own rules
      // say; the walk mirrors the descent "git add" performs and stops there.
      // Every kind of rule can make an ancestor directory ignored, not only the
      // spelling with a trailing slash: "foo", "*.log", "a/*" and "**/cache"
      // exclude the directory they name exactly as "foo/" does, and git never
      // descends into it, so the subtree goes with it. Asking the rules about
      // that ancestor as a directory is what keeps the answer; a rule that is
      // not directory-only still matches the directory's name. Only a positive
      // verdict stops the walk, which is how "logs/" plus "!logs/keep.txt"
      // leaves that one file visible and how "logs" plus "!logs" re-includes
      // the whole directory.
      const ancestors = segments.length - 1;
      for (let depth = 1; depth <= ancestors; depth += 1) {
        const verdict = verdictAt(accumulated(segments, depth), segments, depth, true);
        if (verdict.ignored && !verdict.lastRuleNegated) return true;
      }
      // The path itself: its own directory's rules apply to it, and to a
      // directory also the rules of the ".gitignore" that directory holds.
      return verdictAt(
        accumulated(segments, isDirectory ? segments.length : segments.length - 1),
        segments,
        segments.length,
        isDirectory,
      ).ignored;
    },
    /** The subset of `paths` the rules exclude, as a Set. */
    ignoredSet(paths) {
      return new Set(paths.filter((relativePath) => this.isIgnored(relativePath)));
    },
    /** Every ".gitignore" the walk reads, repository-relative. */
    files() {
      return findIgnoreFiles(directory);
    },
  };
}
