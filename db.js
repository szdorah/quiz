import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

export async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.warn("DATABASE_URL is not set; database features are unavailable.");
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS quizzes (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS questions (
      id BIGSERIAL PRIMARY KEY,
      quiz_id BIGINT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      question_text TEXT NOT NULL,
      question_type TEXT NOT NULL DEFAULT 'SINGLE_SELECT',
      image_url TEXT,
      time_limit_seconds INTEGER NOT NULL DEFAULT 30,
      points INTEGER NOT NULL DEFAULT 1000,
      order_index INTEGER NOT NULL DEFAULT 0,
      config JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS answer_options (
      id BIGSERIAL PRIMARY KEY,
      question_id BIGINT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      answer_text TEXT NOT NULL DEFAULT '',
      image_url TEXT,
      is_correct BOOLEAN NOT NULL DEFAULT FALSE,
      order_index INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS game_sessions (
      id BIGSERIAL PRIMARY KEY,
      quiz_id BIGINT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      game_code VARCHAR(6) UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'WAITING',
      current_question_index INTEGER NOT NULL DEFAULT -1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS players (
      id BIGSERIAL PRIMARY KEY,
      session_id BIGINT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
      name VARCHAR(40) NOT NULL,
      emoji VARCHAR(16) NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS player_answers (
      id BIGSERIAL PRIMARY KEY,
      player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      question_id BIGINT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      answer_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_correct BOOLEAN,
      response_ms INTEGER,
      points_earned INTEGER NOT NULL DEFAULT 0,
      answered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(player_id, question_id)
    );

    CREATE INDEX IF NOT EXISTS idx_questions_quiz ON questions(quiz_id, order_index);
    CREATE INDEX IF NOT EXISTS idx_options_question ON answer_options(question_id, order_index);
    CREATE INDEX IF NOT EXISTS idx_players_session ON players(session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_code ON game_sessions(game_code);
  `);
}

export async function listQuizzes() {
  const { rows } = await pool.query(`
    SELECT q.id, q.title, q.description, q.created_at,
           COUNT(qq.id)::int AS question_count
    FROM quizzes q
    LEFT JOIN questions qq ON qq.quiz_id = q.id
    GROUP BY q.id
    ORDER BY q.updated_at DESC, q.id DESC
  `);
  return rows;
}

export async function createQuiz({ title, description = "", questions = [] }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const quizResult = await client.query(
      "INSERT INTO quizzes(title, description) VALUES($1,$2) RETURNING *",
      [title, description]
    );
    const quiz = quizResult.rows[0];

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const questionResult = await client.query(
        `INSERT INTO questions
          (quiz_id, question_text, question_type, image_url, time_limit_seconds, points, order_index, config)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          quiz.id,
          q.questionText,
          q.questionType || "SINGLE_SELECT",
          q.imageUrl || null,
          Number(q.timeLimitSeconds || 30),
          Number(q.points || 1000),
          i,
          q.config || {},
        ]
      );
      const questionId = questionResult.rows[0].id;
      const options = Array.isArray(q.options) ? q.options : [];
      for (let j = 0; j < options.length; j++) {
        const option = options[j];
        await client.query(
          `INSERT INTO answer_options(question_id, answer_text, image_url, is_correct, order_index)
           VALUES($1,$2,$3,$4,$5)`,
          [questionId, option.text || "", option.imageUrl || null, !!option.isCorrect, j]
        );
      }
    }

    await client.query("COMMIT");
    return quiz;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function randomGameCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function startGame(quizId) {
  for (let i = 0; i < 20; i++) {
    const code = randomGameCode();
    try {
      const { rows } = await pool.query(
        `INSERT INTO game_sessions(quiz_id, game_code, status)
         VALUES($1,$2,'WAITING')
         RETURNING id, quiz_id, game_code, status, created_at`,
        [quizId, code]
      );
      return rows[0];
    } catch (error) {
      if (error.code === "23505") continue;
      throw error;
    }
  }
  throw new Error("Nem sikerült egyedi játékkódot generálni.");
}

export async function getSessionByCode(code) {
  const { rows } = await pool.query(
    `SELECT gs.*, q.title AS quiz_title
     FROM game_sessions gs
     JOIN quizzes q ON q.id = gs.quiz_id
     WHERE gs.game_code = $1`,
    [code]
  );
  return rows[0] || null;
}

export async function addPlayer({ code, name, emoji }) {
  const session = await getSessionByCode(code);
  if (!session) return { error: "Nincs ilyen aktív játékkód." };
  if (session.status !== "WAITING") return { error: "Ehhez a játékhoz már nem lehet csatlakozni." };

  const { rows } = await pool.query(
    `INSERT INTO players(session_id, name, emoji)
     VALUES($1,$2,$3)
     RETURNING id, session_id, name, emoji, score, joined_at`,
    [session.id, name, emoji]
  );
  return { player: rows[0], session };
}

export async function listPlayersBySession(sessionId) {
  const { rows } = await pool.query(
    `SELECT id, name, emoji, score, joined_at
     FROM players WHERE session_id = $1 ORDER BY joined_at ASC`,
    [sessionId]
  );
  return rows;
}
