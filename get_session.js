import "dotenv/config";
import { input, password } from "@inquirer/prompts";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

function readRequiredEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function readRequiredNumberEnv(name) {
  const value = Number(readRequiredEnv(name));

  if (!Number.isInteger(value)) {
    throw new Error(`Environment variable ${name} must be a valid integer`);
  }

  return value;
}

async function main() {
  const apiId = readRequiredNumberEnv("API_ID");
  const apiHash = readRequiredEnv("API_HASH");
  // This utility is only for generating a fresh session string once.
  const session = new StringSession("");

  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  try {
    await client.start({
      phoneNumber: async () => input({ message: "Phone number:" }),
      password: async () =>
        password({ message: "Two-factor password (leave empty if none):" }),
      phoneCode: async () => input({ message: "Telegram login code:" }),
      onError: (error) => {
        console.error("Telegram login error:", error);
      },
    });

    console.log("\nSESSION STRING\n");
    console.log(client.session.save());
    console.log(
      "\nAdd this value to SESSION in your .env file, then keep the file private.",
    );
  } finally {
    await client.disconnect();
  }
}

main().catch((error) => {
  console.error("Failed to create Telegram session:", error);
  process.exitCode = 1;
});
