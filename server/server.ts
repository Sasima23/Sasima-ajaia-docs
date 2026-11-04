
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

dotenv.config({ path: "../.env" });

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is missing in .env");
}

// Add authenticated user ID to Express request
declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

// Authentication middleware
function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET!) as {
      userId: string;
    };

    req.userId = decoded.userId;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

app.get("/", (_req, res) => {
  res.send("Ajaia Docs API is running!");
});

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT NOW()");
    res.json({ status: "success", database: "connected" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Database connection failed" });
  }
});

// REGISTER
app.post("/api/auth/register", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!name || !email || !password) {
      return res.status(400).json({
        error: "Name, email and password are required"
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Enter a valid email address" });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: "Password must contain at least 8 characters"
      });
    }

    const existing = await pool.query(
      "SELECT id FROM users WHERE LOWER(email) = $1",
      [email]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: "An account with this email already exists"
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email`,
      [name, email, passwordHash]
    );

    const user = result.rows[0];

    const token = jwt.sign(
      { userId: user.id },
      JWT_SECRET!,
      { expiresIn: "7d" }
    );

    res.status(201).json({ user, token });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not register account" });
  }
});

// LOGIN
app.post("/api/auth/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password are required"
      });
    }

    const result = await pool.query(
      `SELECT id, name, email, password_hash
       FROM users
       WHERE LOWER(email) = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const user = result.rows[0];
    const passwordMatches = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!passwordMatches) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = jwt.sign(
      { userId: user.id },
      JWT_SECRET!,
      { expiresIn: "7d" }
    );

    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email
      },
      token
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not log in" });
  }
});

// GET CURRENT USER
app.get("/api/auth/me", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, email FROM users WHERE id = $1",
      [req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not fetch user" });
  }
});

// GET OWN DOCUMENTS
app.get("/api/documents", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM documents
       WHERE owner_id = $1
       ORDER BY updated_at DESC`,
      [req.userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not fetch documents" });
  }
});

// CREATE DOCUMENT
app.post("/api/documents", authenticateToken, async (req, res) => {
  try {
    const title = String(req.body.title || "").trim();
    const content = String(req.body.content || "");

    if (!title) {
      return res.status(400).json({ error: "Title is required" });
    }

    const result = await pool.query(
      `INSERT INTO documents (owner_id, title, content)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [req.userId, title, content]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not create document" });
  }
});

// UPDATE OWN DOCUMENT OR SHARED EDITOR DOCUMENT
app.put("/api/documents/:id", authenticateToken, async (req, res) => {
  try {
    const access = await pool.query(
      `SELECT d.id, d.owner_id,
              CASE
                WHEN d.owner_id = $2 THEN 'owner'
                ELSE ds.permission
              END AS permission
       FROM documents d
       LEFT JOIN document_shares ds
         ON ds.document_id = d.id AND ds.user_id = $2
       WHERE d.id = $1
         AND (d.owner_id = $2 OR ds.user_id = $2)`,
      [req.params.id, req.userId]
    );

    if (access.rows.length === 0) {
      return res.status(404).json({ error: "Document not found" });
    }

    if (
      access.rows[0].permission !== "owner" &&
      access.rows[0].permission !== "editor"
    ) {
      return res.status(403).json({ error: "You only have viewer access" });
    }

    const title = req.body.title;
    const content = req.body.content;

    const result = await pool.query(
      `UPDATE documents
       SET title = COALESCE($1, title),
           content = COALESCE($2, content),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING *`,
      [title, content, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not update document" });
  }
});

// DELETE OWN DOCUMENT
app.delete("/api/documents/:id", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM documents
       WHERE id = $1 AND owner_id = $2
       RETURNING id`,
      [req.params.id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Document not found or you are not the owner"
      });
    }

    res.json({ message: "Document deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not delete document" });
  }
});

// SHARE DOCUMENT
app.post("/api/documents/:id/share", authenticateToken, async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const permission = req.body.permission || "viewer";

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Enter a valid email address" });
    }

    if (!["viewer", "editor"].includes(permission)) {
      return res.status(400).json({ error: "Invalid permission" });
    }

    const document = await pool.query(
      "SELECT id FROM documents WHERE id = $1 AND owner_id = $2",
      [req.params.id, req.userId]
    );

    if (document.rows.length === 0) {
      return res.status(404).json({
        error: "Document not found or you are not the owner"
      });
    }

    const collaborator = await pool.query(
      "SELECT id, email FROM users WHERE LOWER(email) = $1",
      [email]
    );

    if (collaborator.rows.length === 0) {
      return res.status(404).json({
        error: "No registered user found with this email"
      });
    }

    if (collaborator.rows[0].id === req.userId) {
      return res.status(400).json({ error: "You already own this document" });
    }

    const result = await pool.query(
      `INSERT INTO document_shares (document_id, user_id, permission)
       VALUES ($1, $2, $3)
       ON CONFLICT (document_id, user_id)
       DO UPDATE SET permission = EXCLUDED.permission
       RETURNING permission`,
      [req.params.id, collaborator.rows[0].id, permission]
    );

    res.status(201).json({
      message: "Document shared successfully",
      email: collaborator.rows[0].email,
      permission: result.rows[0].permission
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not share document" });
  }
});

// GET SHARED DOCUMENTS
app.get("/api/shared-documents", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.id, d.title, d.content, d.updated_at,
              u.name AS owner_name, u.email AS owner_email,
              ds.permission
       FROM document_shares ds
       JOIN documents d ON d.id = ds.document_id
       JOIN users u ON u.id = d.owner_id
       WHERE ds.user_id = $1
       ORDER BY d.updated_at DESC`,
      [req.userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not fetch shared documents" });
  }
});

// LIST COLLABORATORS
app.get("/api/documents/:id/shares", authenticateToken, async (req, res) => {
  try {
    const owner = await pool.query(
      "SELECT id FROM documents WHERE id = $1 AND owner_id = $2",
      [req.params.id, req.userId]
    );

    if (owner.rows.length === 0) {
      return res.status(404).json({ error: "Document not found" });
    }

    const result = await pool.query(
      `SELECT u.email, ds.permission, ds.created_at
       FROM document_shares ds
       JOIN users u ON u.id = ds.user_id
       WHERE ds.document_id = $1`,
      [req.params.id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not fetch collaborators" });
  }
});

// REVOKE ACCESS
app.delete(
  "/api/documents/:id/share/:email",
  authenticateToken,
  async (req, res) => {
    try {
      const result = await pool.query(
        `DELETE FROM document_shares ds
         USING documents d, users u
         WHERE ds.document_id = d.id
           AND ds.user_id = u.id
           AND d.id = $1
           AND d.owner_id = $2
           AND LOWER(u.email) = LOWER($3)
         RETURNING ds.id`,
        [req.params.id, req.userId, req.params.email]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Share not found" });
      }

      res.json({ message: "Collaborator access revoked" });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Could not revoke access" });
    }
  }
);

app.listen(PORT, () => {
  console.log(`Ajaia Docs API running at http://localhost:${PORT}`);
});
