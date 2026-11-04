import { useEffect, useRef, useState } from "react";
import {
  FileText, Plus, Search, Share2, Bold, Italic, Underline,
  List, ListOrdered, Trash2, Upload, Check, Download, LogOut
} from "lucide-react";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import UnderlineExtension from "@tiptap/extension-underline";
import "./App.css";

type Doc = {
  id: string;
  title: string;
  content: string;
  updated: string;
  permission?: "owner" | "viewer" | "editor";
  owner_name?: string;
  owner_email?: string;
};

type User = {
  id: string;
  name: string;
  email: string;
};

const API = "http://localhost:5000/api";
const TOKEN_KEY = "ajaia_token";

export default function App() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [sharedDocs, setSharedDocs] = useState<Doc[]>([]);
  const docsRef = useRef(docs);
  const sharedRef = useRef(sharedDocs);
  docsRef.current = docs;
  sharedRef.current = sharedDocs;

  const [user, setUser] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authName, setAuthName] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState("");
  const [query, setQuery] = useState("");
  const [showShared, setShowShared] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [notice, setNotice] = useState("");

  const fileRef = useRef<HTMLInputElement>(null);
  const saveTimers = useRef<Record<string, number>>({});
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  function apiFetch(path: string, options: RequestInit = {}, token?: string) {
    const authToken = token || localStorage.getItem(TOKEN_KEY) || "";
    const headers = new Headers(options.headers);
    headers.set("Content-Type", "application/json");
    if (authToken) headers.set("Authorization", `Bearer ${authToken}`);

    return fetch(`${API}${path}`, {
      ...options,
      headers
    });
  }

  function mapDocument(doc: any, permission?: Doc["permission"]): Doc {
    return {
      id: doc.id,
      title: doc.title || "Untitled document",
      content: doc.content || "",
      updated: doc.updated_at
        ? new Date(doc.updated_at).toLocaleString()
        : new Date().toLocaleString(),
      permission: permission || doc.permission || "owner",
      owner_name: doc.owner_name,
      owner_email: doc.owner_email
    };
  }

  async function loadWorkspace(token: string) {
    const [myResponse, sharedResponse] = await Promise.all([
      apiFetch("/documents", {}, token),
      apiFetch("/shared-documents", {}, token)
    ]);

    if (!myResponse.ok) {
      throw new Error("Could not load your documents.");
    }

    if (!sharedResponse.ok) {
      throw new Error("Could not load shared documents.");
    }

    const myData = await myResponse.json();
    const sharedData = await sharedResponse.json();

    const own = myData.map((doc: any) => mapDocument(doc, "owner"));
    const shared = sharedData.map((doc: any) =>
      mapDocument(doc, doc.permission || "viewer")
    );

    setDocs(own);
    setSharedDocs(shared);
    setActiveId(own[0]?.id || shared[0]?.id || "");
  }

  // Check whether the user already has a valid login session.
  useEffect(() => {
    async function checkSession() {
      const token = localStorage.getItem(TOKEN_KEY);

      if (!token) {
        setLoading(false);
        return;
      }

      try {
        const response = await apiFetch("/auth/me", {}, token);
        if (!response.ok) throw new Error("Session expired");

        const data = await response.json();
        setUser(data.user || data);

        await loadWorkspace(token);
      } catch (error) {
        console.error(error);
        localStorage.removeItem(TOKEN_KEY);
        setUser(null);
        setNotice("Please log in to continue.");
      } finally {
        setLoading(false);
      }
    }

    checkSession();

    return () => {
      Object.values(saveTimers.current).forEach(timer =>
        window.clearTimeout(timer)
      );
    };
  }, []);

  async function submitAuth(e: React.FormEvent) {
    e.preventDefault();
    setAuthLoading(true);
    setNotice("");

    try {
      const endpoint = authMode === "register"
        ? "/auth/register"
        : "/auth/login";

      const body = authMode === "register"
        ? { name: authName.trim(), email: authEmail.trim(), password: authPassword }
        : { email: authEmail.trim(), password: authPassword };

      const response = await apiFetch(endpoint, {
        method: "POST",
        body: JSON.stringify(body)
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Authentication failed.");
      }

      if (!data.token) {
        throw new Error("The server did not return a login token.");
      }

      localStorage.setItem(TOKEN_KEY, data.token);
      setUser(data.user);
      setAuthPassword("");
      await loadWorkspace(data.token);
      setNotice(
        authMode === "register"
          ? "Your Ajaia account has been created!"
          : "Welcome back!"
      );
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Could not sign in."
      );
    } finally {
      setAuthLoading(false);
    }
  }

  function logout() {
    Object.values(saveTimers.current).forEach(timer =>
      window.clearTimeout(timer)
    );
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
    setDocs([]);
    setSharedDocs([]);
    setActiveId("");
    setNotice("");
    setAuthEmail("");
    setAuthPassword("");
  }

  const activeDoc = [...docs, ...sharedDocs].find(d => d.id === activeId);
  const canEdit = activeDoc?.permission !== "viewer";

  // Update a document locally and save it to PostgreSQL.
  function updateDoc(id: string, patch: Partial<Doc>) {
    const currentDoc = [...docsRef.current, ...sharedRef.current]
      .find(d => d.id === id);

    if (currentDoc?.permission === "viewer") {
      setNotice("You have view-only access to this document.");
      return;
    }

    setDocs(previous =>
      previous.map(d => d.id === id
        ? { ...d, ...patch, updated: new Date().toLocaleString() }
        : d)
    );

    setSharedDocs(previous =>
      previous.map(d => d.id === id
        ? { ...d, ...patch, updated: new Date().toLocaleString() }
        : d)
    );

    window.clearTimeout(saveTimers.current[id]);

    saveTimers.current[id] = window.setTimeout(async () => {
      try {
        const response = await apiFetch(`/documents/${id}`, {
          method: "PUT",
          body: JSON.stringify(patch)
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || "Save failed.");
        }

        setNotice("");
      } catch (error) {
        console.error(error);
        setNotice(
          error instanceof Error ? error.message : "Document could not be saved."
        );
      }
    }, 700);
  }

  const editor = useEditor({
    extensions: [StarterKit, UnderlineExtension],
    content: "",
    editable: canEdit,
    onUpdate: ({ editor }) => {
      const id = activeIdRef.current;
      if (id) updateDoc(id, { content: editor.getHTML() });
    }
  });

  // Change editor content only when switching documents.
  useEffect(() => {
    const doc = [...docsRef.current, ...sharedRef.current]
      .find(item => item.id === activeId);

    if (doc && editor) {
      editor.commands.setContent(doc.content || "", false);
    }
  }, [activeId, editor]);

  useEffect(() => {
    editor?.setEditable(canEdit);
  }, [editor, canEdit]);

  async function createDoc() {
    try {
      const response = await apiFetch("/documents", {
        method: "POST",
        body: JSON.stringify({
          title: "Untitled document",
          content: "<p>Start writing your document...</p>"
        })
      });

      const saved = await response.json();
      if (!response.ok) throw new Error(saved.error || "Could not create document.");

      const doc = mapDocument(saved, "owner");
      setDocs(previous => [doc, ...previous]);
      setActiveId(doc.id);
      setShowShared(false);
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not create document.");
    }
  }

  async function deleteDoc(id: string) {
    if (!window.confirm("Delete this document?")) return;

    try {
      const response = await apiFetch(`/documents/${id}`, {
        method: "DELETE"
      });

      if (!response.ok) throw new Error("Delete failed.");

      window.clearTimeout(saveTimers.current[id]);
      const remaining = docs.filter(d => d.id !== id);
      setDocs(remaining);

      if (activeId === id) setActiveId(remaining[0]?.id || sharedDocs[0]?.id || "");
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not delete document.");
    }
  }

  function format(command: string) {
    if (!editor || !canEdit) return;
    const chain = editor.chain().focus();

    switch (command) {
      case "bold": chain.toggleBold().run(); break;
      case "italic": chain.toggleItalic().run(); break;
      case "underline": chain.toggleUnderline().run(); break;
      case "bulletList": chain.toggleBulletList().run(); break;
      case "orderedList": chain.toggleOrderedList().run(); break;
      case "paragraph": chain.setParagraph().run(); break;
      case "h1": chain.toggleHeading({ level: 1 }).run(); break;
      case "h2": chain.toggleHeading({ level: 2 }).run(); break;
      case "h3": chain.toggleHeading({ level: 3 }).run(); break;
    }
  }

  function handleUpload(file?: File) {
    if (!file || !activeDoc || !canEdit) return;

    const name = file.name.toLowerCase();

    if (![".txt", ".md", ".html"].some(ext => name.endsWith(ext))) {
      setNotice("Please upload a TXT, MD or HTML file.");
      return;
    }

    const reader = new FileReader();

    reader.onload = () => {
      const text = String(reader.result ?? "");
      const content = name.endsWith(".html")
        ? text
        : text.split(/\n{2,}/).map(block => {
            const safeText = block.split("\n").map(line =>
              line.replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
            ).join("<br>");
            return `<p>${safeText}</p>`;
          }).join("");

      editor?.commands.setContent(content);
      updateDoc(activeDoc.id, {
        title: file.name.replace(/\.[^.]+$/, ""),
        content
      });
      setNotice("File imported successfully!");
    };

    reader.onerror = () => setNotice("Could not read this file.");
    reader.readAsText(file);
  }

  function exportDoc() {
    if (!activeDoc) return;

    const content = editor?.getHTML() ?? activeDoc.content;
    const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>${activeDoc.title}</title></head>
<body>${content}</body>
</html>`;

    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${activeDoc.title || "document"}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function prepareShare() {
    if (!activeDoc) {
      setNotice("Please open a document first.");
      return;
    }

    if (!email.includes("@")) {
      setNotice("Enter a valid email address.");
      return;
    }

    try {
      const response = await apiFetch(`/documents/${activeDoc.id}/share`, {
        method: "POST",
        body: JSON.stringify({
          email: email.trim(),
          permission: "editor"
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not share document.");

      setNotice(`Document shared with ${data.email || email}!`);
      setEmail("");
      setShareOpen(false);
      const token = localStorage.getItem(TOKEN_KEY);
      if (token) await loadWorkspace(token);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not share document.");
    }
  }

  const wordCount = editor
    ? editor.getText().trim().split(/\s+/).filter(Boolean).length
    : 0;

  const visibleDocs = (showShared ? sharedDocs : docs).filter(d =>
    d.title.toLowerCase().includes(query.toLowerCase())
  );

  if (loading) {
    return <div className="empty-state">Loading Ajaia Docs...</div>;
  }

  // Login and registration screen.
  if (!user) {
    return (
      <div className="auth-screen">
        <form className="auth-card" onSubmit={submitAuth}>
          <img src="/logo_d.png" alt="Ajaia Logo" className="auth-logo" />
          <h1>{authMode === "login" ? "Welcome back" : "Create your account"}</h1>
          <p>Sign in to your Ajaia Docs workspace.</p>

          {authMode === "register" && (
            <label>
              Your name
              <input
                value={authName}
                onChange={e => setAuthName(e.target.value)}
                placeholder="Your name"
                required
              />
            </label>
          )}

          <label>
            Email address
            <input
              type="email"
              value={authEmail}
              onChange={e => setAuthEmail(e.target.value)}
              placeholder="name@example.com"
              required
            />
          </label>

          <label>
            Password
            <input
              type="password"
              value={authPassword}
              onChange={e => setAuthPassword(e.target.value)}
              placeholder="Enter your password"
              minLength={6}
              required
            />
          </label>

          {notice && <p className="auth-notice" role="status">{notice}</p>}

          <button className="primary auth-submit" type="submit" disabled={authLoading}>
            {authLoading
              ? "Please wait..."
              : authMode === "login" ? "Log in" : "Create account"}
          </button>

          <p className="auth-switch">
            {authMode === "login" ? "New to Ajaia Docs?" : "Already have an account?"}
            {" "}
            <button
              type="button"
              onClick={() => {
                setAuthMode(authMode === "login" ? "register" : "login");
                setNotice("");
              }}
            >
              {authMode === "login" ? "Create account" : "Log in"}
            </button>
          </p>
        </form>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/logo_d.png" alt="Ajaia Logo" className="brand-logo" />
        </div>

        <button className="primary new-button" onClick={createDoc}>
          <Plus size={18} /> New document
        </button>

        <div className="section-label">YOUR WORKSPACE</div>

        <button
          className={`workspace-tab ${!showShared ? "selected" : ""}`}
          onClick={() => {
            setShowShared(false);
            setActiveId(docs[0]?.id || "");
          }}
        >
          My documents
        </button>

        <button
          className={`workspace-tab ${showShared ? "selected" : ""}`}
          onClick={() => {
            setShowShared(true);
            setActiveId(sharedDocs[0]?.id || "");
          }}
        >
          Shared with me ({sharedDocs.length})
        </button>

        <label className="search-box">
          <Search size={16} />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search documents"
          />
        </label>

        <div className="document-list">
          {visibleDocs.map(doc => (
            <div
              key={doc.id}
              className={`document-item ${activeId === doc.id ? "active" : ""}`}
            >
              <button
                className="document-select"
                onClick={() => setActiveId(doc.id)}
              >
                <FileText size={17} />
                <span>{doc.title}</span>
              </button>

              {!showShared && (
                <button
                  className="icon-button"
                  aria-label="Delete document"
                  onClick={() => deleteDoc(doc.id)}
                >
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          ))}

          {visibleDocs.length === 0 && (
            <p className="muted">
              {showShared ? "No shared documents yet." : "No documents yet."}
            </p>
          )}
        </div>

        <div className="sidebar-footer">
          <div className="avatar">{user.name?.charAt(0).toUpperCase() || "A"}</div>
          <div className="user-details">
            <strong>{user.name}</strong>
            <span>{user.email}</span>
            <button className="logout-button" onClick={logout}>
              <LogOut size={13} /> Log out
            </button>
          </div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="breadcrumbs">
            Workspace <span>/</span> {showShared ? "Shared with me" : "Documents"}
          </div>

          <div className="top-actions">
            <span className="saved-status">
              <Check size={14} /> Database storage
            </span>

            <button
              className="primary"
              onClick={() => {
                setShareOpen(v => !v);
                setNotice("");
              }}
              disabled={!activeDoc || activeDoc.permission !== "owner"}
            >
              <Share2 size={16} /> Share
            </button>
          </div>
        </header>

        {activeDoc ? (
          <section className="editor-area">
            <div className="document-heading">
              <input
                className="title-input"
                value={activeDoc.title}
                readOnly={!canEdit}
                onChange={e => updateDoc(activeDoc.id, { title: e.target.value })}
                aria-label="Document title"
              />
              <p>
                {activeDoc.permission === "owner"
                  ? "Your document"
                  : `Shared by ${activeDoc.owner_name || activeDoc.owner_email || "a collaborator"}`}
                {" · "}Last updated {activeDoc.updated}
                {!canEdit && " · View only"}
              </p>
            </div>

            <div className="toolbar">
              <button type="button" title="Bold" disabled={!canEdit}
                className={editor?.isActive("bold") ? "is-active" : ""}
                onMouseDown={e => e.preventDefault()} onClick={() => format("bold")}>
                <Bold size={17} />
              </button>
              <button type="button" title="Italic" disabled={!canEdit}
                className={editor?.isActive("italic") ? "is-active" : ""}
                onMouseDown={e => e.preventDefault()} onClick={() => format("italic")}>
                <Italic size={17} />
              </button>
              <button type="button" title="Underline" disabled={!canEdit}
                className={editor?.isActive("underline") ? "is-active" : ""}
                onMouseDown={e => e.preventDefault()} onClick={() => format("underline")}>
                <Underline size={17} />
              </button>

              <span className="toolbar-divider" />

              <button type="button" title="Bulleted list" disabled={!canEdit}
                className={editor?.isActive("bulletList") ? "is-active" : ""}
                onMouseDown={e => e.preventDefault()} onClick={() => format("bulletList")}>
                <List size={17} />
              </button>
              <button type="button" title="Numbered list" disabled={!canEdit}
                className={editor?.isActive("orderedList") ? "is-active" : ""}
                onMouseDown={e => e.preventDefault()} onClick={() => format("orderedList")}>
                <ListOrdered size={17} />
              </button>

              <select
                aria-label="Text style"
                disabled={!canEdit}
                value={
                  editor?.isActive("heading", { level: 1 }) ? "h1" :
                  editor?.isActive("heading", { level: 2 }) ? "h2" :
                  editor?.isActive("heading", { level: 3 }) ? "h3" : "p"
                }
                onChange={e => format(e.target.value)}
              >
                <option value="p">Paragraph</option>
                <option value="h1">Heading 1</option>
                <option value="h2">Heading 2</option>
                <option value="h3">Heading 3</option>
              </select>

              <span className="toolbar-spacer" />

              <button type="button" title="Import file" disabled={!canEdit}
                onMouseDown={e => e.preventDefault()}
                onClick={() => fileRef.current?.click()}>
                <Upload size={17} />
              </button>

              <input
                ref={fileRef}
                type="file"
                hidden
                accept=".txt,.md,.html"
                onChange={e => {
                  handleUpload(e.target.files?.[0]);
                  e.currentTarget.value = "";
                }}
              />

              <button type="button" title="Export HTML"
                onMouseDown={e => e.preventDefault()} onClick={exportDoc}>
                <Download size={17} />
              </button>
            </div>

            <EditorContent editor={editor} className="page-editor" />

            <div className="editor-footnote">
              <span><Check size={14} /> Saved to database</span>
              <span>{wordCount} words</span>
            </div>
          </section>
        ) : (
          <div className="empty-state">
            <FileText size={42} />
            <h2>{showShared ? "No shared documents yet" : "Your next idea starts here"}</h2>
            <p>{showShared ? "Documents shared with you will appear here." : "Create a document to get started."}</p>
            {!showShared && (
              <button className="primary" onClick={createDoc}>
                <Plus size={16} /> New document
              </button>
            )}
          </div>
        )}
      </main>

      {shareOpen && (
        <div className="modal-backdrop" onClick={() => setShareOpen(false)}>
          <section className="share-modal" onClick={e => e.stopPropagation()}>
            <h2>Share document</h2>
            <p>Give a registered Ajaia user editor access.</p>

            <label htmlFor="share-email">Email address</label>
            <input
              id="share-email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="name@example.com"
            />

            <p className="muted">The recipient must already have an Ajaia account.</p>
            {notice && <p role="status">{notice}</p>}

            <div className="modal-actions">
              <button className="secondary" onClick={() => setShareOpen(false)}>Cancel</button>
              <button className="primary" onClick={prepareShare}>Share document</button>
            </div>
          </section>
        </div>
      )}

      {notice && !shareOpen && (
        <button className="notice" onClick={() => setNotice("")}>
          {notice} ×
        </button>
      )}
    </div>
  );
}