import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  transports: ["websocket", "polling"],
});

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "szagri-quiz" });
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/play", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "play.html"));
});

io.on("connection", (socket) => {
  socket.emit("hello", { connected: true });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`SZAGRI Quiz running on port ${PORT}`);
});
