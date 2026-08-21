import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const appSecret = process.env.APP_DB_SECRET;

function getClient() {
  if (!supabaseUrl || !supabaseKey || !appSecret) throw new Error("Supabase configuration is missing");
  return createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function rpc(name, payload = {}) {
  const { data, error } = await getClient().rpc(name, { p_secret: appSecret, ...payload });
  if (error) throw new Error(error.message || "Supabase RPC error");
  return data;
}

function first(rows) { return Array.isArray(rows) ? rows[0] : rows; }
function normalizeQuestion(row, number = null) {
  return {
    id: row.question_id,
    questionType: row.question_type,
    prompt: row.prompt,
    imageUrl: row.image_url,
    options: row.options || [],
    settings: row.settings || {},
    questionNumber: number ?? row.question_number ?? null,
    questionTotal: row.question_total ?? null,
  };
}

export async function initDb() { await rpc("api_list_quizzes"); }
export async function listQuizzes() { return (await rpc("api_list_quizzes")) || []; }

export async function createQuiz({ title, description = "", questions = [] }) {
  const normalized = questions.map(q => {
    const options = Array.isArray(q.options) ? q.options : [];
    return {
      questionType: String(q.questionType || "single_select").toLowerCase(),
      prompt: String(q.questionText || q.prompt || "").trim(),
      imageUrl: q.imageUrl || null,
      options: options.map(o => ({ text: String(o?.text || ""), imageUrl: o?.imageUrl || null })),
      correctAnswer: options.map((o, i) => o?.isCorrect ? i : null).filter(i => i !== null),
      settings: { timeLimitSeconds: Number(q.timeLimitSeconds || 30), points: Number(q.points || 1000), ...(q.config || {}) },
    };
  });
  const id = await rpc("api_create_quiz", { p_title: title, p_description: description, p_questions: normalized });
  return { id, title, description };
}

export async function startGame(quizId) {
  const row = first(await rpc("api_start_game", { p_quiz_id: quizId }));
  return { id: row.game_id, quiz_id: quizId, game_code: row.code, status: "waiting" };
}

export async function beginGame(gameId) {
  const row = first(await rpc("api_begin_game", { p_game_id: gameId }));
  if (!row) throw new Error("A kvízben nincs kérdés.");
  return { gameId: row.game_id, question: normalizeQuestion(row, 1) };
}

export async function getGameState(gameId) {
  const row = first(await rpc("api_get_game_state", { p_game_id: gameId }));
  if (!row) return null;
  return {
    status: row.status,
    question: row.question_id ? normalizeQuestion(row) : null,
  };
}

export async function submitAnswer({ playerId, questionId, selectedIndex }) {
  try {
    const row = first(await rpc("api_submit_answer", { p_player_id: playerId, p_question_id: questionId, p_selected_index: selectedIndex }));
    return { ok: true, ...row };
  } catch (error) {
    const message = String(error.message || "");
    if (message.includes("already_answered")) return { error: "Erre a kérdésre már válaszoltál." };
    if (message.includes("question_not_active")) return { error: "Ez a kérdés már nem aktív." };
    if (message.includes("game_not_running")) return { error: "A játék jelenleg nem fut." };
    throw error;
  }
}

export async function nextQuestion(gameId) {
  const row = first(await rpc("api_next_question", { p_game_id: gameId }));
  if (!row) throw new Error("Nem sikerült továbblépni.");
  if (row.game_status === "finished") return { status: "finished" };
  return { status: "running", question: normalizeQuestion(row) };
}

export async function leaderboard(gameId) { return (await rpc("api_leaderboard", { p_game_id: gameId })) || []; }

export async function addPlayer({ code, name, emoji }) {
  try {
    const row = first(await rpc("api_join_game", { p_code: code, p_name: name, p_emoji: emoji }));
    return {
      player: { id: row.player_id, session_id: row.game_id, name: row.name, emoji: row.emoji, score: 0 },
      session: { id: row.game_id, game_code: row.code, status: "waiting" },
    };
  } catch (error) {
    const message = String(error.message || "");
    if (message.includes("game_not_found")) return { error: "Nincs ilyen aktív játékkód." };
    if (message.includes("name_taken")) return { error: "Ez a név már szerepel ebben a játékban." };
    throw error;
  }
}

export async function listPlayersBySession(sessionId) { return (await rpc("api_list_players", { p_game_id: sessionId })) || []; }
