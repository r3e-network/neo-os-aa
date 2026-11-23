import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { NATIVE_STANDARD_RECOVERY_NEF_SHA256 } from "../shared/nativeSmartAccountClient.mjs";

const actual = createHash("sha256").update(readFileSync(process.argv[2])).digest("hex");
if (actual !== NATIVE_STANDARD_RECOVERY_NEF_SHA256) throw new Error("The SDK recovery pin does not match the freshly compiled standard module");
console.log("Standard recovery module matches the SDK code pin.");
