import { commandDefinitions } from "../src/discord/commands.js";
const {
  DISCORD_APPLICATION_ID: id,
  DISCORD_BOT_TOKEN: token,
  DISCORD_TEST_GUILD_ID: guild,
} = process.env;
if (!/^\d{17,22}$/.test(id || "") || !token) {
  console.error(
    "Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN as environment variables.",
  );
  process.exit(1);
}
const global = process.argv.includes("--global");
if (!global && !/^\d{17,22}$/.test(guild || "")) {
  console.error(
    "Set DISCORD_TEST_GUILD_ID for development registration, or explicitly use --global.",
  );
  process.exit(1);
}
const url = `https://discord.com/api/v10/applications/${id}${global ? "" : `/guilds/${guild}`}/commands`;
const r = await fetch(url, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(commandDefinitions),
});
if (!r.ok) {
  console.error(
    `Registration failed: HTTP ${r.status}. No token or response body logged.`,
  );
  process.exit(1);
}
console.log(
  `Registered ${(await r.json()).length} commands in ${global ? "global" : "development guild"} scope.`,
);
