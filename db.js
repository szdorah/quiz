import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const appSecret = process.env.APP_DB_SECRET;

function getClient() {
  if (!supabaseUrl || !supabaseKey || !appSecret) {
    throw new Error("Supabase configuration is missing");
  }
  return createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function rpc(name, payload = {}) {
  const client = getClient();
  const { data, error } = await client.rpc(name, { p_secret: appSecret, ...payload });
  if (error) throw new Error(error.message || "Supabase RPC error");
  return data;
}

export async function initDb() {
  await rpc("api_list_quizzes");
}

export async function listQuizzes() {
  return (await rpc("api_list_quizzes")) || [];
}

export async function createQuiz({ title, description = "", questions = [] }) {
  const normalized = questions.map((q) => {
    const options = Array.isArray(q.options) ? q.options : [];
    const correctIndexes = options
      .map((option, index) => option?.isCorrect ? index : null)
      .filter(index => index !== null);

    return {
      questionType: String(q.questionType || "single_select").toLowerCase(),
      prompt: String(q.questionText || q.prompt || "").trim(),
      imageUrl: q.imageUrl || null,
      options: options.map(option => ({ text: String(option?.text || ""), imageUrl: option?.imageUrl || null })),
      correctAnswer: correctIndexes,
      settings: {
        timeLimitSeconds: Number(q.timeLimitSeconds || 30),
        points: Number(q.points || 1000),
        ...(q.config || {}),
      },
    };
  });

  const id = await rpc("api_create_quiz", {
    p_title: title,
    p_description: description,
    p_questions: normalized,
  });
  return { id, title, description };
}

export async function startGame(quizId) {
  const rows = await rpc("api_start_game", { p_quiz_id: quizId });
  const row = Array.isArray(rows) ? rows[0] : rows;
  return { id: row.game_id, quiz_id: quizId, game_code: row.code, status: "waiting" };
}

export async function addPlayer({ code, name, emoji }) {
  try {
    const rows = await rpc("api_join_game", { p_code: code, p_name: name, p_emoji: emoji });
    const row = Array.isArray(rows) ? rows[0] : rows;
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

export async function listPlayersBySession(sessionId) {
  return (await rpc("api_list_players", { p_game_id: sessionId })) || [];
}
