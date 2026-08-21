import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  transports: ["websocket", "polling"],
});

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "dev-secret-change-me";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map(part => {
    const [k, ...v] = part.trim().split("=");
    return [k, decodeURIComponent(v.join("="))];
  }));
}

function adminToken() {
  return crypto.createHmac("sha256", ADMIN_SECRET).update("szagri-admin").digest("hex");
}

function isAdmin(req) {
  return parseCookies(req).szagri_admin === adminToken();
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.redirect("/admin");
  next();
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "szagri-quiz" }));
app.get("/admin", (req, res) => {
  if (isAdmin(req)) return res.redirect("/admin/dashboard");
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
app.get("/admin/dashboard", requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, "public", "admin-dashboard.html")));
app.get("/admin/quiz/new", requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, "public", "quiz-new.html")));
app.get("/play", (_req, res) => res.sendFile(path.join(__dirname, "public", "play.html")));
app.get("/waiting", (_req, res) => res.sendFile(path.join(__dirname, "public", "waiting.html")));

app.post("/api/admin/login", (req, res) => {
  const password = String(req.body?.password || "");
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, error: "Hibás jelszó." });
  res.setHeader("Set-Cookie", `szagri_admin=${adminToken()}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`);
  res.json({ ok: true });
});

app.post("/api/admin/logout", (_req, res) => {
  res.setHeader("Set-Cookie", "szagri_admin=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.post("/api/join", (req, res) => {
  const code = String(req.body?.code || "").trim();
  const name = String(req.body?.name || "").trim();
  const emoji = String(req.body?.emoji || "").trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: "A játékkód 6 számjegyből álljon." });
  if (name.length < 2 || name.length > 40) return res.status(400).json({ ok: false, error: "Adj meg egy nevet (2–40 karakter)." });
  if (!emoji) return res.status(400).json({ ok: false, error: "Válassz emojit." });
  res.json({ ok: true, player: { code, name, emoji } });
});

io.on("connection", socket => socket.emit("hello", { connected: true }));

server.listen(PORT, "0.0.0.0", () => console.log(`SZAGRI Quiz running on port ${PORT}`));
