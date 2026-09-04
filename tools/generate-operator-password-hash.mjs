import { randomBytes, scryptSync } from "node:crypto";
import { fileURLToPath } from "node:url";

const SCRYPT_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 1,
    maxmem: 64 * 1024 * 1024 });

export function createOperatorPasswordVerifier(password, salt = randomBytes(16)) {
    if (typeof password !== "string" || password.length < 12) {
        throw new TypeError("Password must contain at least 12 characters.");
    }
    if (!Buffer.isBuffer(salt) || salt.length < 16) {
        throw new TypeError("Salt must contain at least 16 bytes.");
    }
    const digest = scryptSync(password, salt, 64, SCRYPT_OPTIONS);
    return `scrypt$16384$8$1$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

async function readHidden(prompt) {
    if (!process.stdin.isTTY || !process.stdout.isTTY ||
        typeof process.stdin.setRawMode !== "function") {
        throw new Error("An interactive terminal is required.");
    }
    process.stderr.write(prompt);
    process.stdin.setEncoding("utf8");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    return new Promise((resolve, reject) => {
        let value = "";
        const finish = (error) => {
            process.stdin.off("data", onData);
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stderr.write("\n");
            if (error) reject(error); else resolve(value);
        };
        const onData = (chunk) => {
            for (const character of chunk) {
                if (character === "\u0003") return finish(new Error("Cancelled."));
                if (character === "\r" || character === "\n") return finish();
                if (character === "\b" || character === "\u007f") value = value.slice(0, -1);
                else if (character >= " ") value += character;
            }
        };
        process.stdin.on("data", onData);
    });
}

async function main() {
    if (process.argv.length > 2) throw new Error("This helper accepts no password arguments.");
    let password = ""; let confirmation = "";
    try {
        password = await readHidden("Operator password: ");
        confirmation = await readHidden("Confirm password: ");
        if (password !== confirmation) throw new Error("Passwords do not match.");
        process.stdout.write(`${createOperatorPasswordVerifier(password)}\n`);
    }
    finally { password = ""; confirmation = ""; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
