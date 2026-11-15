// Shared by the public pages (docs, support, about, terms, privacy): reflects the
// sign-in state in the navigation. The server remains the only authority; this
// only changes which links and buttons are shown.
(async () => {
  const account = document.getElementById("account");
  if (!account) return;
  let session;
  try {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    if (!res.ok) return;
    session = await res.json();
  } catch {
    return;
  }
  const dash = document.querySelector('[data-nav="dashboard"]');
  if (dash) dash.setAttribute("href", "/");
  const name = document.createElement("span");
  name.className = "username";
  name.textContent = session.user.username;
  const out = document.createElement("button");
  out.type = "button";
  out.textContent = "Sign out";
  out.addEventListener("click", async () => {
    out.disabled = true;
    try {
      await fetch("/api/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrf,
        },
        body: "{}",
      });
    } finally {
      // A 401 means the session already ended on the server; either way we are signed out.
      location.assign("/");
    }
  });
  account.replaceChildren(name, out);
})();
