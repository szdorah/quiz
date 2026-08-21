import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import QRCode from "qrcode";
import * as XLSX from "xlsx";
import {
  initDb, listQuizzes, getQuiz, createQuiz, updateQuiz, deleteQuiz, duplicateQuiz,
  startGame, beginGame, getGameState, addPlayer, listPlayersBySession, submitAnswer,
  nextQuestion, leaderboard, answerDistribution, archiveGame, listArchives, getArchive
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true }, transports: ["websocket", "polling"] });
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "dev-secret-change-me";

app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map(part => {
    const [k, ...v] = part.trim().split("="); return [k, decodeURIComponent(v.join("="))];
  }));
}
function adminToken() { return crypto.createHmac("sha256", ADMIN_SECRET).update("szagri-admin").digest("hex"); }
function isAdmin(req) { return parseCookies(req).szagri_admin === adminToken(); }
function requireAdmin(req,res,next) { if (!isAdmin(req)) return res.redirect("/admin"); next(); }
function requireAdminApi(req,res,next) { if (!isAdmin(req)) return res.status(401).json({ok:false,error:"Nincs oktatói jogosultság."}); next(); }
function isUuid(v) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v)); }
function quizPayload(body) {
  return { title:String(body?.title||"").trim(), description:String(body?.description||"").trim(), questions:Array.isArray(body?.questions)?body.questions:[] };
}
function validateQuiz(data) {
  if (data.title.length < 2 || data.title.length > 120) return "A kvíz címe 2–120 karakter legyen.";
  if (!data.questions.length) return "Adj hozzá legalább egy kérdést.";
  if (data.questions.some(q => !String(q.questionText || q.prompt || "").trim())) return "Minden kérdésnek legyen szövege.";
  return null;
}

app.get("/health", (_req,res)=>res.json({ok:true,service:"szagri-quiz",database:!!process.env.SUPABASE_URL}));
app.get("/admin", (req,res)=>isAdmin(req)?res.redirect("/admin/dashboard"):res.sendFile(path.join(__dirname,"public","admin.html")));
app.get("/admin/dashboard", requireAdmin, (_req,res)=>res.sendFile(path.join(__dirname,"public","admin-dashboard.html")));
app.get(["/admin/quiz/new","/admin/quiz/edit"], requireAdmin, (_req,res)=>res.sendFile(path.join(__dirname,"public","quiz-new.html")));
app.get("/play", (_req,res)=>res.sendFile(path.join(__dirname,"public","play.html")));
app.get("/waiting", (_req,res)=>res.sendFile(path.join(__dirname,"public","waiting.html")));
app.get("/game", (_req,res)=>res.sendFile(path.join(__dirname,"public","game.html")));

app.post("/api/admin/login", (req,res)=>{
  if (String(req.body?.password||"")!==ADMIN_PASSWORD) return res.status(401).json({ok:false,error:"Hibás jelszó."});
  res.setHeader("Set-Cookie",`szagri_admin=${adminToken()}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`); res.json({ok:true});
});
app.post("/api/admin/logout", (_req,res)=>{res.setHeader("Set-Cookie","szagri_admin=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");res.json({ok:true});});

app.get("/api/quizzes", requireAdminApi, async (_req,res)=>{try{res.json({ok:true,quizzes:await listQuizzes()});}catch(e){console.error(e);res.status(500).json({ok:false,error:"Nem sikerült betölteni a kvízeket."});}});
app.get("/api/quizzes/:id", requireAdminApi, async (req,res)=>{try{if(!isUuid(req.params.id))return res.status(400).json({ok:false,error:"Hibás kvízazonosító."});res.json({ok:true,quiz:await getQuiz(req.params.id)});}catch(e){console.error(e);res.status(404).json({ok:false,error:"A kvíz nem található."});}});
app.post("/api/quizzes", requireAdminApi, async (req,res)=>{try{const d=quizPayload(req.body),err=validateQuiz(d);if(err)return res.status(400).json({ok:false,error:err});res.json({ok:true,quiz:await createQuiz(d)});}catch(e){console.error(e);res.status(500).json({ok:false,error:"Nem sikerült elmenteni a kvízt."});}});
app.put("/api/quizzes/:id", requireAdminApi, async (req,res)=>{try{if(!isUuid(req.params.id))return res.status(400).json({ok:false,error:"Hibás kvízazonosító."});const d=quizPayload(req.body),err=validateQuiz(d);if(err)return res.status(400).json({ok:false,error:err});res.json({ok:true,quiz:await updateQuiz(req.params.id,d)});}catch(e){console.error(e);const m=String(e.message||"");res.status(m.includes("active")?409:500).json({ok:false,error:m.includes("active")?"Futó vagy várakozó játék mellett a kvíz nem szerkeszthető.":"Nem sikerült módosítani a kvízt."});}});
app.post("/api/quizzes/:id/duplicate", requireAdminApi, async (req,res)=>{try{if(!isUuid(req.params.id))return res.status(400).json({ok:false,error:"Hibás kvízazonosító."});res.json({ok:true,id:await duplicateQuiz(req.params.id)});}catch(e){console.error(e);res.status(500).json({ok:false,error:"Nem sikerült másolni a kvízt."});}});
app.delete("/api/quizzes/:id", requireAdminApi, async (req,res)=>{try{if(!isUuid(req.params.id))return res.status(400).json({ok:false,error:"Hibás kvízazonosító."});await deleteQuiz(req.params.id);res.json({ok:true});}catch(e){console.error(e);res.status(500).json({ok:false,error:"Nem sikerült törölni a kvízt."});}});

app.post("/api/quizzes/:id/start", requireAdminApi, async (req,res)=>{try{if(!isUuid(req.params.id))return res.status(400).json({ok:false,error:"Hibás kvízazonosító."});const session=await startGame(req.params.id);const joinUrl=`${req.protocol}://${req.get("host")}/play?code=${session.game_code}`;const qrDataUrl=await QRCode.toDataURL(joinUrl,{width:320,margin:1});res.json({ok:true,session,joinUrl,qrDataUrl});}catch(e){console.error(e);res.status(500).json({ok:false,error:"Nem sikerült elindítani a kvízt."});}});
app.post("/api/games/:id/begin", requireAdminApi, async (req,res)=>{try{const state=await beginGame(req.params.id);io.to(`session:${req.params.id}`).emit("game:question",state.question);res.json({ok:true,question:state.question});}catch(e){console.error(e);res.status(400).json({ok:false,error:"A játék nem indítható."});}});
app.post("/api/games/:id/next", requireAdminApi, async (req,res)=>{try{const state=await nextQuestion(req.params.id);if(state.status==="finished"){const board=await leaderboard(req.params.id);await archiveGame(req.params.id);io.to(`session:${req.params.id}`).emit("game:finished",board);return res.json({ok:true,status:"finished",leaderboard:board});}io.to(`session:${req.params.id}`).emit("game:question",state.question);res.json({ok:true,status:"running",question:state.question});}catch(e){console.error(e);res.status(400).json({ok:false,error:"Nem sikerült a következő kérdésre lépni."});}});
app.get("/api/games/:id/leaderboard", requireAdminApi, async (req,res)=>{try{res.json({ok:true,leaderboard:await leaderboard(req.params.id)});}catch(e){res.status(500).json({ok:false,error:"Nem sikerült betölteni az eredményt."});}});

app.post("/api/answers", async (req,res)=>{
  try {
    const playerId=String(req.body?.playerId||""),questionId=String(req.body?.questionId||"");
    if(!isUuid(playerId)||!isUuid(questionId)||!req.body?.answer) return res.status(400).json({ok:false,error:"Hibás válaszadat."});
    const result=await submitAnswer({playerId,questionId,answer:req.body.answer}); if(result.error)return res.status(409).json({ok:false,error:result.error});
    const room=`session:${req.body?.sessionId||""}`;
    io.to(room).emit("answers:progress",{answeredCount:Number(result.answered_count),playerCount:Number(result.player_count)});
    if(isUuid(req.body?.sessionId||"")) io.to(room).emit("answers:distribution",await answerDistribution(req.body.sessionId));
    res.json({ok:true,result});
  } catch(e){console.error(e);res.status(500).json({ok:false,error:"Nem sikerült beküldeni a választ."});}
});

app.post("/api/join", async (req,res)=>{try{const code=String(req.body?.code||"").trim(),name=String(req.body?.name||"").trim(),emoji=String(req.body?.emoji||"").trim();if(!/^\d{6}$/.test(code))return res.status(400).json({ok:false,error:"A játékkód 6 számjegyből álljon."});if(name.length<2||name.length>40)return res.status(400).json({ok:false,error:"Adj meg egy nevet (2–40 karakter)."});if(!emoji)return res.status(400).json({ok:false,error:"Válassz emojit."});const result=await addPlayer({code,name,emoji});if(result.error)return res.status(404).json({ok:false,error:result.error});io.to(`session:${result.session.id}`).emit("players:update",await listPlayersBySession(result.session.id));res.json({ok:true,player:{...result.player,code},session:result.session});}catch(e){console.error(e);res.status(500).json({ok:false,error:"Nem sikerült csatlakozni."});}});

app.get("/api/results", requireAdminApi, async (_req,res)=>{try{res.json({ok:true,results:await listArchives()});}catch(e){console.error(e);res.status(500).json({ok:false,error:"Nem sikerült betölteni az eredményarchívumot."});}});
app.get("/api/results/:id", requireAdminApi, async (req,res)=>{try{res.json({ok:true,result:await getArchive(req.params.id)});}catch(e){res.status(404).json({ok:false,error:"Az eredmény nem található."});}});
app.get("/api/results/:id/xlsx", requireAdminApi, async (req,res)=>{
  try {
    const a=await getArchive(req.params.id),players=Array.isArray(a.players)?a.players:[],questions=Array.isArray(a.questions)?a.questions:[];
    const wb=XLSX.utils.book_new();
    const summary=[{Kvíz:a.quizTitle||"",Kód:a.code||"",Kezdés:a.startedAt||"",Befejezés:a.endedAt||"",Résztvevők:players.length}];
    const students=players.map((p,i)=>({Helyezés:i+1,Név:p.name,Emoji:p.emoji,Pont:p.score}));
    const qMap=new Map(questions.map(q=>[q.id,q]));
    const answers=[]; for(const p of players) for(const x of (p.answers||[])){const q=qMap.get(x.questionId)||{};answers.push({Név:p.name,Kérdés_sorszáma:Number(q.position??0)+1,Kérdés:q.prompt||"",Típus:q.questionType||"",Válasz:JSON.stringify(x.answer||{}),Helyes:x.isCorrect?"Igen":"Nem / részben",Pont:x.scoreAwarded??0});}
    XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(summary),"Összesítés");
    XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(students),"Hallgatók");
    XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(answers),"Válaszok kérdésenként");
    const buf=XLSX.write(wb,{type:"buffer",bookType:"xlsx"});const safe=String(a.quizTitle||"quiz").replace(/[^a-zA-Z0-9áéíóöőúüűÁÉÍÓÖŐÚÜŰ_-]+/g,"_");
    res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");res.setHeader("Content-Disposition",`attachment; filename="${safe}_eredmeny.xlsx"`);res.send(buf);
  } catch(e){console.error(e);res.status(500).json({ok:false,error:"Nem sikerült elkészíteni az Excel-fájlt."});}
});

io.on("connection",socket=>{
  socket.on("session:watch",async id=>{if(!isUuid(id))return;socket.join(`session:${id}`);try{socket.emit("players:update",await listPlayersBySession(id));socket.emit("answers:distribution",await answerDistribution(id));}catch(e){console.error(e);}});
  socket.on("session:join",async id=>{if(!isUuid(id))return;socket.join(`session:${id}`);try{const s=await getGameState(id);if(s?.status==="running"&&s.question)socket.emit("game:question",s.question);if(s?.status==="finished")socket.emit("game:finished",await leaderboard(id));}catch(e){console.error(e);}});
});

async function start(){try{await initDb();server.listen(PORT,"0.0.0.0",()=>console.log(`SZAGRI Quiz running on port ${PORT}`));}catch(e){console.error("Database initialization failed",e);process.exit(1);}}
start();
