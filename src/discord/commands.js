import { queueUI } from "./review-ui.js";
import { availableForms, publishForm, closeForm } from "../modules/forms.js";
import { ownApplication } from "../modules/applications.js";
import { introData, reply, myApplicationsData } from "./apply-flow.js";
import { authorize } from "../modules/permissions.js";
import { publishPanel } from "../modules/panels.js";
import { button, select } from "./responses.js";
import { id as validId } from "../utils/validation.js";
import { setupGuild } from "../modules/guilds.js";
import { message, embed, row, link } from "./responses.js";
export const commandDefinitions = [
  { name: "help", description: "How to use RoApp" },
  { name: "setup", description: "Initialize RoApp for this community" },
  { name: "dashboard", description: "Open the RoApp Dashboard" },
  { name: "apply", description: "Choose an application form" },
  { name: "myapplications", description: "View your applications" },
  {
    name: "application",
    description: "Manage your application",
    options: [
      {
        type: 1,
        name: "view",
        description: "View your own application",
        options: [
          {
            type: 3,
            name: "reference",
            description: "Application reference",
            required: true,
          },
        ],
      },
      {
        type: 1,
        name: "withdraw",
        description: "Withdraw your own application",
        options: [
          {
            type: 3,
            name: "reference",
            description: "Application reference",
            required: true,
          },
        ],
      },
    ],
  },
  {
    name: "review",
    description: "Open the private application review workspace",
  },
  {
    name: "forms",
    description: "Community forms",
    options: [
      { type: 1, name: "list", description: "List forms" },
      { type: 1, name: "create", description: "Open the form builder" },
      {
        type: 1,
        name: "publish",
        description: "Publish the current form draft",
        options: [
          { type: 3, name: "id", description: "Form ID", required: true },
        ],
      },
      {
        type: 1,
        name: "close",
        description: "Close a form",
        options: [
          { type: 3, name: "id", description: "Form ID", required: true },
        ],
      },
    ],
  },
  {
    name: "panel",
    description: "Persistent application panels",
    options: [
      {
        type: 1,
        name: "publish",
        description: "Publish or update a panel",
        options: [
          {
            type: 3,
            name: "id",
            description: "Panel ID from the dashboard",
            required: true,
          },
        ],
      },
      {
        type: 1,
        name: "update",
        description: "Update a panel",
        options: [
          { type: 3, name: "id", description: "Panel ID", required: true },
        ],
      },
      {
        type: 1,
        name: "remove",
        description: "Request panel removal",
        options: [
          { type: 3, name: "id", description: "Panel ID", required: true },
        ],
      },
    ],
  },
  { name: "staff", description: "Open staff and permission settings" },
].map((c) => ({ ...c, contexts: [0], integration_types: [0] }));
export const option = (i, name) => {
  const opts = i.data.options || [];
  return [...opts, ...opts.flatMap((x) => x.options || [])].find(
    (o) => o.name === name,
  )?.value;
};
export async function handleCommand(i, env) {
  if (i.data.name === "setup") {
    await setupGuild(env, i.guild_id, i.member.user.id);
    return message(
      "RoApp is configured. Open the dashboard to create forms and grant staff access.",
      { components: [row(link("Open Dashboard", env.APP_ORIGIN))] },
    );
  }
  if (i.data.name === "help")
    return message("RoApp helps your community manage applications.", {
      embeds: [
        embed(
          "RoApp help",
          "Use /apply to apply, /myapplications to check progress, and /application to view or withdraw. Authorized staff use /review. Community owners use /setup and the dashboard.",
        ),
      ],
      components: [row(link("RoApp Dashboard", env.APP_ORIGIN))],
    });
  if (["dashboard", "staff"].includes(i.data.name))
    return message(
      "Sign in with Discord. Each community checks access independently.",
      { components: [row(link("Open Dashboard", env.APP_ORIGIN))] },
    );
  const user = i.member?.user?.id,
    guild = i.guild_id;
  if (i.data.name === "review")
    return queueUI(
      env,
      await authorize(env, guild, user, "applications.review"),
    );
  if (i.data.name === "apply") {
    return formChoices(env, guild, user, 0);
  }
  if (i.data.name === "myapplications") {
    const d = await myApplicationsData(env, guild, user);
    return message(d.content, { embeds: d.embeds, components: d.components });
  }
  if (i.data.name === "application") {
    const ref = validId(option(i, "reference"));
    const a = await ownApplication(env, guild, user, ref);
    if (i.data.options[0].name === "withdraw")
      return message(`Confirm withdrawal of ${a.id}.`, {
        components: [
          row(
            button(
              "Confirm withdrawal",
              `withdraw:${user}:${a.id}:${a.revision}`,
              4,
            ),
          ),
        ],
      });
    return message(`${a.id}: ${a.status}`, {
      embeds: [
        embed(
          a.definition.title,
          a.decision_reason || "No applicant-facing decision reason.",
        ),
      ],
      components: [
        row(
          link("View answers / revisions", env.APP_ORIGIN + `/?mine=${guild}`),
        ),
      ],
    });
  }
  if (i.data.name === "forms") {
    const sub = i.data.options[0].name;
    const access = await authorize(env, guild, user, "forms.manage");
    if (sub === "create")
      return message("Build and order questions on the dashboard.", {
        components: [row(link("Form builder", env.APP_ORIGIN))],
      });
    if (sub === "list") {
      const { listForms } = await import("../database/queries.js");
      const forms = await listForms(env, guild);
      return message("Community forms", {
        embeds: [
          embed(
            "Forms",
            forms
              .slice(0, 20)
              .map(
                (f) =>
                  `${JSON.parse(f.draft_json).title} — ${f.status}\nID: ${f.id}`,
              )
              .join("\n") || "No forms yet.",
          ),
        ],
      });
    }
    const id = validId(option(i, "id"));
    if (sub === "publish") await publishForm(env, access, id);
    else await closeForm(env, access, id);
    return message(
      `Form ${sub === "publish" ? "published" : "closed"}. Update any published panels using /panel update.`,
    );
  }
  if (i.data.name === "panel") {
    const access = await authorize(env, guild, user, "panels.manage"),
      id = validId(option(i, "id"));
    if (i.data.options[0].name === "remove")
      return message("Confirm removal of this panel and its public message.", {
        components: [row(button("Confirm removal", `remove:${user}:${id}`, 4))],
      });
    await publishPanel(env, access, id);
    return message("Panel published or updated.");
  }
  return message("Unknown command. Use /help.");
}

export async function formChoices(env, guild, user, page = 0) {
  const forms = await availableForms(env, guild);
  if (!Number.isSafeInteger(page) || page < 0 || page > 1000)
    return message("Invalid form page. Use /apply.");
  // A single open form needs no selection step: go straight to its introduction.
  if (forms.length === 1 && page === 0)
    return reply(await introData(env, guild, user, forms[0].id));
  const visible = forms.slice(page * 25, page * 25 + 25),
    components = visible.length
      ? [
          select(
            `forms:${user}`,
            visible.map((f) => ({
              label: f.title.slice(0, 100),
              value: f.id,
              ...(f.description
                ? { description: f.description.slice(0, 100) }
                : {}),
            })),
            "Select an application…",
          ),
        ]
      : [];
  const controls = [];
  if (page > 0)
    controls.push(button("Previous forms", `formpage:${user}:${page - 1}`));
  if (forms.length > (page + 1) * 25)
    controls.push(button("More forms", `formpage:${user}:${page + 1}`));
  if (controls.length) components.push(row(...controls));
  return message(
    visible.length ? "Choose a form to begin." : "No forms are open.",
    { components },
  );
}
