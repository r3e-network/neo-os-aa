// Pins the semantics of scripts/lib/gitignore-rules.mjs, the no-git reader the
// hygiene test falls back to in a clean "git archive" export.
//
// The hygiene test proves the fallback agrees with "git check-ignore" over the
// repository's own rules. This file proves the reader implements the rules
// ".gitignore" defines, with a fixture whose expected answers are written down
// by hand and, when git is available, checked against git itself in a
// throwaway repository. A reader that answered "ignored" for everything, or
// "not ignored" for everything, fails here before it can weaken the hygiene
// gate.
//
// The hygiene test's cross-check can only compare the paths this repository
// happens to contain, so a pattern no current path exercises can be read
// wrongly and still pass there: the reader is the only oracle in a clean
// "git archive" export, which is the environment the review service mandates.
// The `ORACLE_CASES` table below is therefore chosen for what this tree does
// NOT contain, and each pattern is measured in a throwaway repository of its
// own so that no pattern can mask another.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileIgnorePattern, loadIgnoreRules, parseIgnoreLine } from "./gitignore-rules.mjs";

// Each entry is [path, isDirectory, ignored]. The fixture repository below
// writes the ".gitignore" files these answers come from.
const FIXTURE_RULES = [
  ["node_modules/pkg/index.js", false, true],
  ["frontend/node_modules/pkg/index.js", false, true],
  ["sdk/js/dist/index.js", false, true],
  ["dist/index.js", false, true],
  ["anchored/only.js", false, true],
  ["nested/anchored/only.js", false, false],
  // A pattern whose slash is not leading is anchored to the ".gitignore"'s
  // directory too: "/root-only/" names the root copy, not "nested/root-only/".
  ["root-only/here.txt", false, true],
  ["nested/root-only/here.txt", false, false],
  ["build.out", false, true],
  ["keep/build.out", false, false],
  [".env", false, true],
  ["deploy/.env_prod", false, true],
  ["frontend/.env.production.local", false, true],
  [".env.example", false, false],
  ["frontend/.env.example", false, false],
  ["contracts/bin/v3/UnifiedSmartWallet.nef", false, true],
  ["Graph/Graph.csproj", false, false],
  ["bin/Graph.csproj", false, true],
  ["Graph/keep.csproj", false, false],
  [".codegraph/codegraph.db", false, true],
  [".codegraph/daemon.pid", false, true],
  [".codegraph/.gitignore", false, false],
  [".codegraph/nested/deep.json", false, true],
  ["tools/.codegraph/codegraph.db", false, true],
  ["logs/run.txt", false, true],
  ["logs/keep.txt", false, true],
  ["logs/secret.txt", false, true],
  ["a/**/b/target.txt", false, true],
  ["a/b/target.txt", false, true],
  ["a/x/y/b/target.txt", false, true],
  ["b/target.txt", false, false],
  ["file?.txt", false, true],
  ["file1.txt", false, true],
  ["file12.txt", false, false],
  ["class/a.txt", false, true],
  ["class/b.txt", false, true],
  ["class/c.txt", false, false],
  ["escaped[1].txt", false, true],
  ["name with space.txt", false, true],
  ["dir-only", true, true],
  ["dir-only/child.txt", false, true],
  // A directory whose own ".gitignore" negates a parent rule: git still does
  // not descend here, so the file below stays ignored.
  ["!trap", false, false],
  ["trap/keep.txt", false, true],
  ["local/child/.gitignore", false, false],
  ["local/child/tmp/cache.bin", false, true],
  ["local/child/keep.bin", false, false],
];

const FIXTURE_IGNORE_FILES = {
  ".gitignore": [
    "# a comment",
    "",
    "node_modules/",
    "/anchored/",
    "/root-only/",
    "dist/",
    "*.out",
    "!keep/build.out",
    ".env*",
    "!.env.example",
    "bin/",
    "!Graph/keep.csproj",
    "logs/",
    "!logs/keep.txt",
    "**/.codegraph/*",
    "!**/.codegraph/.gitignore",
    "a/**/b/",
    "file?.txt",
    "class/[ab].txt",
    "escaped\\[1\\].txt",
    "name with space.txt   ",
    "dir-only/",
    "!trap",
    "trap/",
  ].join("\n"),
  // The repository's own CodeGraph rule: the database is ignored at every
  // depth, the tracked self-ignoring file is not.
  ".codegraph/.gitignore": ["*", "!.gitignore"].join("\n"),
  "local/child/.gitignore": ["tmp/", "!keep.bin"].join("\n"),
};

// Every compared path is materialised as a file so git can be asked about it:
// the reader does not require a path to exist, git does. A path whose last
// segment is listed here is created as a directory instead.
const FIXTURE_DIRECTORIES = ["dir-only", ".codegraph", "logs", "trap", "local/child/tmp"];
const FIXTURE_FILES = [
  ".gitignore",
  "logs/keep.txt",
  "logs/secret.txt",
  ".codegraph/.gitignore",
  ".codegraph/codegraph.db",
  "local/child/.gitignore",
  "local/child/keep.bin",
  "bin/Graph.csproj",
  "Graph/Graph.csproj",
  "Graph/keep.csproj",
];

function writeFixtureRepository(location) {
  for (const [relative, content] of Object.entries(FIXTURE_IGNORE_FILES)) {
    const file = path.join(location, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${content}\n`);
  }
  for (const [relative] of FIXTURE_RULES) {
    if (FIXTURE_DIRECTORIES.includes(relative)) continue;
    const file = path.join(location, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, "x\n");
  }
  for (const relative of FIXTURE_DIRECTORIES) {
    fs.mkdirSync(path.join(location, relative), { recursive: true });
  }
}

function gitAvailable() {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** git's own answers for a batch of paths inside a real repository. */
function gitIgnoredSet(repository, paths) {
  try {
    const output = execFileSync(
      "git",
      ["-C", repository, "-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "--stdin"],
      { encoding: "utf8", input: `${paths.join("\n")}\n`, stdio: ["pipe", "pipe", "ignore"] },
    );
    return new Set(output.split("\n").filter(Boolean));
  } catch (error) {
    if (error.status === 1) return new Set();
    throw error;
  }
}

test("a pattern line is read the way git reads it", () => {
  assert.equal(parseIgnoreLine("# comment"), null, "a whole-line comment carries no pattern");
  assert.equal(parseIgnoreLine("   # not a comment"), "   # not a comment", "a comment needs its # in column one");
  assert.equal(parseIgnoreLine(""), null, "a blank line carries no pattern");
  assert.equal(parseIgnoreLine("node_modules/"), "node_modules/");
  assert.equal(parseIgnoreLine("name with space.txt   "), "name with space.txt", "trailing spaces are not part of the pattern");
  assert.equal(parseIgnoreLine("name with one escaped\\ "), "name with one escaped\\ ", "an escaped trailing space is part of the pattern");

  assert.equal(compileIgnorePattern("!").negated, false, "a lone ! is an ordinary character");
  assert.equal(compileIgnorePattern("!").regex.test("!"), true);
  assert.equal(compileIgnorePattern("dist/").directoryOnly, true);
  assert.equal(compileIgnorePattern("/dist/").directoryOnly, true);
  assert.equal(compileIgnorePattern("a/b").anchored, true);
  assert.equal(compileIgnorePattern("b").anchored, false);
});

test("the fixture rules read the same in the reader and in git", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "gitignore-rules-"));
  try {
    writeFixtureRepository(fixture);
    const rules = loadIgnoreRules(fixture);

    const reader = new Map();
    for (const [relative, isDirectory] of FIXTURE_RULES) {
      reader.set(relative, rules.isIgnored(relative, isDirectory));
    }
    for (const [relative, , expected] of FIXTURE_RULES) {
      assert.equal(reader.get(relative), expected, `${relative} should be ${expected ? "ignored" : "not ignored"}`);
    }

    if (!gitAvailable()) return;
    // Only paths that exist can be asked of git; the rest are pinned above.
    execFileSync("git", ["-C", fixture, "init", "-q"], { stdio: "ignore" });
    const compared = FIXTURE_RULES.filter(([relative]) => fs.existsSync(path.join(fixture, relative)));
    assert.ok(
      compared.length >= FIXTURE_RULES.length - 1,
      `the fixture must compare nearly every path with git, compared ${compared.length} of ${FIXTURE_RULES.length}`,
    );
    const gitSays = gitIgnoredSet(fixture, compared.map(([relative]) => relative));
    const disagreements = compared
      .filter(([relative]) => gitSays.has(relative) !== reader.get(relative))
      .map(([relative]) => `${relative}: reader ${reader.get(relative)}, git ${gitSays.has(relative)}`);
    assert.deepEqual(disagreements, [], `the reader and git disagree:\n  ${disagreements.join("\n  ")}`);

    // The hand-written answers must agree with git too, or the fixture is
    // pinning the reader's mistakes.
    const wrongExpectations = compared
      .filter(([relative, , expected]) => gitSays.has(relative) !== expected)
      .map(([relative, , expected]) => `${relative}: expected ${expected}, git says ${gitSays.has(relative)}`);
    assert.deepEqual(wrongExpectations, [], `the fixture's own expectations disagree with git:\n  ${wrongExpectations.join("\n  ")}`);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("a rule that matches nothing cannot silently pass", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "gitignore-rules-empty-"));
  try {
    fs.writeFileSync(path.join(fixture, ".gitignore"), "nothing-matches-this\n");
    const rules = loadIgnoreRules(fixture);
    assert.equal(rules.isIgnored("node_modules/pkg/index.js"), false, "an unrelated rule ignores nothing");
    assert.equal(rules.isIgnored("nothing-matches-this"), true, "the rule it does name still matches");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

// Each entry is [pattern, cases] and each case is [path, isDirectory, ignored].
// One of these patterns produced a wrong answer that no path in this tree could
// expose, which is the defect this table exists to close: the negated classes
// were inverted, a trailing "/**/" ignored the wrong paths, a trailing "/**"
// named the directory it was supposed to exclude, and an unclosed "[" was read
// as a literal character where git stops reading the pattern.
//
// The second half of the table answers a second round of the same defect: a
// rule that matches a directory excludes everything below it, and a reader that
// propagated only the directory-only spelling of a rule lost the whole subtree
// of every ordinary pattern. The ".vercel" entry is the literal case the
// hygiene gate pinned and the export answered wrongly.
const ORACLE_CASES = [
  // "[!...]" and "[^...]" select the characters the class excludes, and both
  // spellings are valid.
  ["[!a].txt", [["b.txt", false, true], ["a.txt", false, false], ["c.txt", false, true]]],
  ["[^a].txt", [["b.txt", false, true], ["a.txt", false, false]]],
  ["[!abc].txt", [["d.txt", false, true], ["a.txt", false, false]]],
  ["[!a-c].txt", [["d.txt", false, true], ["b.txt", false, false], ["-", false, false]]],
  ["x[!y]z", [["xaz", false, true], ["xyz", false, false]]],
  ["x[^y]z", [["xaz", false, true], ["xyz", false, false]]],
  ["[!.]*.txt", [["a.txt", false, true], [".hidden.txt", false, false]]],
  ["[!0-9]*", [["a1", false, true], ["1a", false, false]]],
  // A class is one path segment, so a negated class must not match the
  // separator; a pattern without a slash still answers about the basename, so
  // "[!a]*" ignores "aa/deep" through its last segment.
  ["[!a]*", [["deep", false, true], ["aa/deep", false, true], ["ab", false, false]]],
  // A class is closed by its last "]": an earlier "]" is an ordinary member,
  // and git reads a "-" in front of a member as a range.
  ["[]]", [["]", false, true], ["a", false, false]]],
  ["[[:digit:]].txt", [["1.txt", false, true], ["x.txt", false, false]]],
  ["[a-c]", [["b", false, true], ["d", false, false]]],
  ["[-a]", [["a", false, true], ["-", false, true], ["b", false, false]]],
  // "**" in directory position spans zero or more whole directories ...
  ["**/foo", [["foo", false, true], ["aa/foo", false, true], ["aa/bb/foo", false, true], ["foobar", false, false]]],
  ["a/**/b", [["a/b", false, true], ["a/x/b", false, true], ["a/x/y/b", false, true], ["a/xb", false, false]]],
  ["foo/**/bar", [["foo/bar", false, true], ["foo/x/bar", false, true], ["foo/x/y/bar", false, true]]],
  ["lib/**/*.js", [["lib/a.js", false, true], ["lib/x/a.js", false, true], ["lib/x/y/a.js", false, true], ["lib/a.ts", false, false]]],
  ["**/node_modules/", [["node_modules/x", false, true], ["nn/node_modules/x", false, true], ["node_modules", true, true]]],
  // ... and a trailing "**" needs at least one name after it, so it excludes
  // what is inside the directory before it and never that directory.
  ["foo/**", [["foo", true, false], ["foo/x.txt", false, true], ["foo/bar/y.txt", false, true]]],
  ["a/**", [["a", true, false], ["a/child.txt", false, true], ["a/deep/child.txt", false, true]]],
  // A trailing "/**/" ignores what is inside foo's subdirectories and nothing
  // else: not foo, not its direct children, and not the pattern's own prefix.
  ["foo/**/", [
    ["foo/bar/y.txt", false, true],
    ["foo/x.txt", false, false],
    ["foo/bar", true, true],
    ["foo", true, false],
  ]],
  ["**/", [["dir/deep", true, true], ["dir", true, true]]],
  // "**" alone matches every path, the root included.
  ["**", [["z", false, true], ["z/z", false, true]]],
  // A "[" git cannot close makes it stop reading the pattern, so the pattern
  // matches nothing at all.
  ["a[", [["a[", false, false], ["ab", false, false]]],
  ["[!abc", [["a", false, false], ["[!abc", false, false]]],
  ["a[]b", [["a[]b", false, false], ["ab", false, false]]],
  // A "-" that opens a class body is a member, and the separators the reader
  // adds around a class body must not turn it into a range: wildmatch and this
  // reader both exclude "b" here and neither excludes "-" or "a".
  ["[!-a]", [["a", false, false], ["b", false, true], ["-", false, false], ["--", false, false]]],
  // A rule that names a directory excludes what is inside it whether or not it
  // is spelled with a trailing slash, because "git add" never descends into an
  // excluded directory. Every spelling of a rule is here: a plain basename, a
  // glob, an anchored pattern with a slash, a "**" segment, a class, and a
  // negated class.
  ["foo", [
    ["foo", true, true],
    ["foo/child.txt", false, true],
    ["foo/deep/child.txt", false, true],
    ["x/foo/child.txt", false, true],
    ["foobar", false, false],
  ]],
  [".vercel", [
    [".vercel", true, true],
    [".vercel/project.json", false, true],
    ["frontend/.vercel/project.json", false, true],
    [".vercelx/project.json", false, false],
  ]],
  ["*.log", [
    ["build.log", true, true],
    ["build.log/child.txt", false, true],
    ["x/build.log/child.txt", false, true],
    ["notes.log.txt", false, false],
  ]],
  ["a/*", [
    ["a/b", true, true],
    ["a/b/child.txt", false, true],
    ["x/a/b.txt", false, false],
  ]],
  ["**/cache", [
    ["cache", true, true],
    ["cache/entry.bin", false, true],
    ["x/cache/entry.bin", false, true],
    ["xcache", false, false],
  ]],
  ["[ab]oo", [
    ["aoo", true, true],
    ["aoo/child.txt", false, true],
    ["coo/child.txt", false, false],
  ]],
  ["[!x]oo", [
    ["aoo", true, true],
    ["aoo/child.txt", false, true],
    ["xoo/child.txt", false, false],
  ]],
  // A negation that names the ignored directory itself is the last matching
  // rule for that directory, so the subtree stays visible ...
  ["unbar/\n!unbar", [
    ["unbar", true, false],
    ["unbar/child.txt", false, false],
  ]],
  // ... while a negation that names something below an excluded directory
  // cannot bring it back: git never descends far enough to read it.
  ["ignored\n!ignored/keep.txt", [
    ["ignored/keep.txt", false, true],
    ["ignored/other.txt", false, true],
  ]],
];

/**
 * One isolated repository per pattern: writes that one ".gitignore", creates
 * every compared path, and returns git's verdicts next to a reader bound to the
 * same rules. A directory case is created with a file below it, because that is
 * how the name is known to be a directory, and reading the rules eagerly keeps
 * the reader answering after the repository is removed.
 */
function compareWithGit(pattern, cases) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "gitignore-oracle-"));
  try {
    fs.writeFileSync(path.join(repository, ".gitignore"), `${pattern}\n`);
    // The shape git sees must not depend on the order of the table. A path that
    // another case needs as its parent is always a directory, whatever the case
    // itself declared, and a name already created is never rewritten; so a case
    // that asks about the file "z" and one that asks about "z/z" produce a
    // directory "z" holding a file "zc" and a file "z/z", consistently.
    const directories = new Set();
    for (const [relative, isDirectory] of cases) {
      if (!isDirectory) continue;
      for (
        let parent = path.posix.dirname(relative);
        parent !== "." && parent !== "";
        parent = path.posix.dirname(parent)
      ) {
        directories.add(parent);
      }
    }
    for (const [relative, isDirectory] of cases) {
      if (isDirectory) continue;
      for (
        let parent = path.posix.dirname(relative);
        parent !== "." && parent !== "";
        parent = path.posix.dirname(parent)
      ) {
        directories.add(parent);
      }
    }
    for (const relative of directories) {
      const absolute = path.join(repository, relative);
      if (!fs.existsSync(absolute)) fs.mkdirSync(absolute, { recursive: true });
      const marker = path.join(absolute, "child.txt");
      if (!fs.existsSync(marker)) fs.writeFileSync(marker, "x\n");
    }
    for (const [relative] of cases) {
      if (directories.has(relative)) continue;
      const absolute = path.join(repository, relative);
      if (fs.existsSync(absolute)) continue;
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, "x\n");
    }
    const rules = loadIgnoreRules(repository);
    // "check-ignore" only answers inside a repository; the index stays empty,
    // so "--no-index" keeps the question about the ignore files alone.
    execFileSync("git", ["-C", repository, "-c", "core.excludesFile=/dev/null", "init", "-q"], { stdio: "ignore" });
    // Every path is asked in its bare spelling. Asking "dir/" as well would be
    // a second question: git answers "foo/" as ignored under "foo/**" while
    // "git add" does not exclude the directory itself, which is the property
    // this reader implements.
    const asked = cases.map(([relative]) => relative.replace(/\/+$/, ""));
    const result = spawnSync(
      "git",
      ["-C", repository, "-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "--stdin"],
      { encoding: "utf8", input: `${asked.join("\n")}\n` },
    );
    if (result.error?.code === "ENOENT") return { rules, git: null };
    if (result.status !== 0 && result.status !== 1) {
      assert.fail(`git check-ignore failed for ${JSON.stringify(pattern)}: ${result.stderr}`);
    }
    const reported = new Set((result.stdout ?? "").split("\n").filter(Boolean));
    return { rules, git: new Map(asked.map((askedPath) => [askedPath, reported.has(askedPath)])) };
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
}

test("the reader answers the patterns this tree does not exercise", (t) => {
  const withoutGit = [];
  for (const [pattern, cases] of ORACLE_CASES) {
    const { rules, git } = compareWithGit(pattern, cases);

    // The hand-written answers, which hold whether or not git is installed.
    const disagreements = [];
    const againstGit = [];
    for (const [relative, isDirectory, expected] of cases) {
      const got = rules.isIgnored(relative, isDirectory);
      if (got !== expected) {
        disagreements.push(`${relative} (${isDirectory ? "dir" : "file"}): reader ${got}, should be ${expected}`);
      }
      if (git === null) continue;
      const asked = `${relative.replace(/\/+$/, "")}${isDirectory ? "/" : ""}`;
      const gitSays = git.get(relative.replace(/\/+$/, ""));
      if (gitSays !== got) {
        againstGit.push(`${asked}: reader ${got}, git ${gitSays}`);
      } else if (gitSays !== expected) {
        againstGit.push(`${asked}: pinned ${expected}, git ${gitSays} (the fixture is wrong, not the reader)`);
      }
    }
    assert.deepEqual(
      disagreements,
      [],
      `the reader disagrees with .gitignore for ${JSON.stringify(pattern)}:\n  ${disagreements.join("\n  ")}`,
    );
    if (git === null) withoutGit.push(pattern);
    else {
      assert.deepEqual(
        againstGit,
        [],
        `the reader and git disagree for ${JSON.stringify(pattern)}:\n  ${againstGit.join("\n  ")}`,
      );
    }
  }
  if (withoutGit.length > 0) {
    // git is the oracle these cases were derived from. Without it the pinned
    // answers still run, and the environment is named rather than implied.
    t.diagnostic(`git was unavailable, so ${withoutGit.length} patterns ran against the pinned answers only: ${withoutGit.join(", ")}`);
  }
});
