import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import QRCode from "qrcode";
import {
  initDb, listQuizzes, createQuiz, deleteQuiz, startGame, beginGame, getGameState,
  addPlayer, listPlayersBySession, submitAnswer, nextQuestion, leaderboard
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true }, transports: ["websocket", "polling"] });

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "dev-secret-change-me";

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map(part => {
    const [k, ...v] = part.trim().split("=");
    return [k, decodeURIComponent(v.join("="))];
  }));
}
function adminToken() { return crypto.createHmac("sha256", ADMIN_SECRET).update("szagri-admin").digest("hex"); }
function isAdmin(req) { return parseCookies(req).szagri_admin === adminToken(); }
function requireAdmin(req, res, next) { if (!isAdmin(req)) return res.redirect("/admin"); next(); }
function requireAdminApi(req, res, next) { if (!isAdmin(req)) return res.status(401).json({ ok:false, error:"Nincs oktatói jogosultság." }); next(); }
function isUuid(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value)); }
function cleanIndexes(value) {
  if (!Array.isArray(value)) return null;
  const arr = value.map(Number);
  if (!arr.length || arr.some(i => !Number.isInteger(i) || i < 0) || new Set(arr).size !== arr.length) return null;
  return arr;
}

app.get("/health", (_req,res) => res.json({ ok:true, service:"szagri-quiz", database:!!process.env.SUPABASE_URL }));
app.get("/admin", (req,res) => isAdmin(req) ? res.redirect("/admin/dashboard") : res.sendFile(path.join(__dirname,"public","admin.html")));
app.get("/admin/dashboard", requireAdmin, (_req,res) => res.sendFile(path.join(__dirname,"public","admin-dashboard.html")));
app.get("/admin/quiz/new", requireAdmin, (_req,res) => res.sendFile(path.join(__dirname,"public","quiz-new.html")));
app.get("/play", (_req,res) => res.sendFile(path.join(__dirname,"public","play.html")));
app.get("/waiting", (_req,res) => res.sendFile(path.join(__dirname,"public","waiting.html")));
app.get("/game", (_req,res) => res.sendFile(path.join(__dirname,"public","game.html")));

app.post("/api/admin/login", (req,res) => {
  if (String(req.body?.password || "") !== ADMIN_PASSWORD) return res.status(401).json({ok:false,error:"Hibás jelszó."});
  res.setHeader("Set-Cookie", `szagri_admin=${adminToken()}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`);
  res.json({ok:true});
});
app.post("/api/admin/logout", (_req,res) => {
  res.setHeader("Set-Cookie", "szagri_admin=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ok:true});
});

app.get("/api/quizzes", requireAdminApi, async (_req,res) => {
  try { res.json({ok:true, quizzes:await listQuizzes()}); }
  catch (error) { console.error(error); res.status(500).json({ok:false,error:"Nem sikerült betölteni a kvízeket."}); }
});

app.post("/api/quizzes", requireAdminApi, async (req,res) => {
  try {
    const title = String(req.body?.title || "").trim();
    const description = String(req.body?.description || "").trim();
    const questions = Array.isArray(req.body?.questions) ? req.body.questions : [];
    if (title.length < 2 || title.length > 120) return res.status(400).json({ok:false,error:"A kvíz címe 2–120 karakter legyen."});
    if (!questions.length) return res.status(400).json({ok:false,error:"Adj hozzá legalább egy kérdést."});
    if (questions.some(q => !String(q.questionText || "").trim())) return res.status(400).json({ok:false,error:"Minden kérdésnek legyen szövege."});
    res.json({ok:true, quiz:await createQuiz({title,description,questions})});
  } catch (error) { console.error(error); res.status(500).json({ok:false,error:"Nem sikerült elmenteni a kvízt."}); }
});

app.delete("/api/quizzes/:id", requireAdminApi, async (req,res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ok:false,error:"Hibás kvízazonosító."});
    await deleteQuiz(req.params.id);
    res.json({ok:true});
  } catch (error) { console.error(error); res.status(500).json({ok:false,error:"Nem sikerült törölni a kvízt."}); }
});

app.post("/api/quizzes/:id/start", requireAdminApi, async (req,res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ok:false,error:"Hibás kvízazonosító."});
    const session = await startGame(req.params.id);
    const joinUrl = `${req.protocol}://${req.get("host")}/play?code=${session.game_code}`;
    const qrDataUrl = await QRCode.toDataURL(joinUrl, { width:320, margin:1 });
    res.json({ok:true, session, joinUrl, qrDataUrl});
  } catch (error) { console.error(error); res.status(500).json({ok:false,error:"Nem sikerült elindítani a kvízt."}); }
});

app.post("/api/games/:id/begin", requireAdminApi, async (req,res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ok:false,error:"Hibás játékazonosító."});
    const state = await beginGame(req.params.id);
    io.to(`session:${req.params.id}`).emit("game:question", state.question);
    res.json({ok:true, question:state.question});
  } catch (error) { console.error(error); res.status(400).json({ok:false,error:"A játék nem indítható. Lehet, hogy már elindult."}); }
});

app.post("/api/games/:id/next", requireAdminApi, async (req,res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ok:false,error:"Hibás játékazonosító."});
    const state = await nextQuestion(req.params.id);
    if (state.status === "finished") {
      const board = await leaderboard(req.params.id);
      io.to(`session:${req.params.id}`).emit("game:finished", board);
      return res.json({ok:true,status:"finished",leaderboard:board});
    }
    io.to(`session:${req.params.id}`).emit("game:question", state.question);
    res.json({ok:true,status:"running",question:state.question});
  } catch (error) { console.error(error); res.status(400).json({ok:false,error:"Nem sikerült a következő kérdésre lépni."}); }
});

app.get("/api/games/:id/leaderboard", requireAdminApi, async (req,res) => {
  try { res.json({ok:true,leaderboard:await leaderboard(req.params.id)}); }
  catch (error) { console.error(error); res.status(500).json({ok:false,error:"Nem sikerült betölteni az eredményt."}); }
});

app.post("/api/answers", async (req,res) => {
  try {
    const playerId = String(req.body?.playerId || "");
    const questionId = String(req.body?.questionId || "");
    if (!isUuid(playerId) || !isUuid(questionId)) return res.status(400).json({ok:false,error:"Hibás válaszadat."});

    let answer = req.body?.answer;
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
      const selectedIndexes = cleanIndexes(req.body?.selectedIndexes) || (Number.isInteger(Number(req.body?.selectedIndex)) ? [Number(req.body.selectedIndex)] : null);
      const orderedIndexes = cleanIndexes(req.body?.orderedIndexes);
      if (orderedIndexes) answer = { orderedIndexes };
      else if (selectedIndexes) answer = { selectedIndexes };
    }
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return res.status(400).json({ok:false,error:"Hibás válaszadat."});

    const result = await submitAnswer({playerId,questionId,answer});
    if (result.error) return res.status(409).json({ok:false,error:result.error});
    io.to(`session:${req.body?.sessionId || ""}`).emit("answers:progress", {
      answeredCount:Number(result.answered_count), playerCount:Number(result.player_count)
    });
    res.json({ok:true,result});
  } catch (error) { console.error(error); res.status(500).json({ok:false,error:"Nem sikerült beküldeni a választ."}); }
});

app.post("/api/join", async (req,res) => {
  try {
    const code = String(req.body?.code || "").trim();
    const name = String(req.body?.name || "").trim();
    const emoji = String(req.body?.emoji || "").trim();
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ok:false,error:"A játékkód 6 számjegyből álljon."});
    if (name.length < 2 || name.length > 40) return res.status(400).json({ok:false,error:"Adj meg egy nevet (2–40 karakter)."});
    if (!emoji) return res.status(400).json({ok:false,error:"Válassz emojit."});
    const result = await addPlayer({code,name,emoji});
    if (result.error) return res.status(404).json({ok:false,error:result.error});
    io.to(`session:${result.session.id}`).emit("players:update", await listPlayersBySession(result.session.id));
    res.json({ok:true,player:{...result.player,code},session:result.session});
  } catch (error) { console.error(error); res.status(500).json({ok:false,error:"Nem sikerült csatlakozni."}); }
});

io.on("connection", socket => {
  socket.emit("hello", {connected:true});
  socket.on("session:watch", async sessionId => {
    if (!isUuid(sessionId)) return;
    socket.join(`session:${sessionId}`);
    try { socket.emit("players:update", await listPlayersBySession(sessionId)); }
    catch (error) { console.error(error); }
  });
  socket.on("session:join", async sessionId => {
    if (!isUuid(sessionId)) return;
    socket.join(`session:${sessionId}`);
    try {
      const state = await getGameState(sessionId);
      if (state?.status === "running" && state.question) socket.emit("game:question", state.question);
      if (state?.status === "finished") socket.emit("game:finished", await leaderboard(sessionId));
    } catch (error) { console.error("Game state sync failed", error); }
  });
});

async function start() {
  try {
    await initDb();
    server.listen(PORT,"0.0.0.0",() => console.log(`SZAGRI Quiz running on port ${PORT}`));
  } catch (error) { console.error("Database initialization failed",error); process.exit(1); }
}
start();
