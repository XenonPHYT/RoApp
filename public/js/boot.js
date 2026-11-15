// Runs before first paint on the dashboard page: hides the marketing content while the
// session check is in flight so a signed-in visitor goes straight to their dashboard.
// app.js removes the class as soon as the check finishes; the timer is a safety net.
document.documentElement.classList.add("auth-check");
setTimeout(() => document.documentElement.classList.remove("auth-check"), 4000);
