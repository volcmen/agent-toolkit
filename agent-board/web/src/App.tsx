import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Activity, Archive, Bot, Boxes, ChevronDown, Code2,
  GitBranch, LayoutDashboard, Loader2, Moon, Plus, RefreshCw, Rocket, RotateCcw, Search,
  ShieldCheck, Sparkles, Sun, Users,
} from "lucide-react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle, DialogTrigger,
} from "@/components/ui/dialog"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { chooseProjectId, projectApi } from "@/lib/project-selection"

/** `archived` never appears as a column — only in the archive view and card detail. */
type Status = "triage" | "todo" | "ready" | "running" | "review" | "blocked" | "done" | "archived"
type Project = {
  id: string; name: string; root: string; workdir: string; active: boolean
  cards: number; statuses: Record<string, number>; running: number
}
type Role = { name: string; runtime: string; readOnly: boolean; description: string }
type BoardCard = {
  id: string; short: string; title: string; body: string; status: Status
  role: string | null; runtime: string | null; model: string | null
  priority: number; parents: string[]; tokens: number
  leased: boolean; blockedReason: string | null
  updatedAt: string; allowedActions: string[]
}
type Board = {
  board: string; workdir: string; readOnly: boolean; csrfToken: string
  columns: Status[]; cards: Record<Status, BoardCard[]>; roles: Role[]
  caps: { maxRunning: number; maxRunningPerRole: number; tickSeconds: number }
  dispatching: boolean
}
type ArchivePage = { total: number; limit: number; cards: BoardCard[] }
type Detail = BoardCard & {
  budgetUsd: number | null; maxTurns: number | null; skills: string[]; handoff: string | null
  workspace: string; dependencies: Array<{ id: string; title: string | null; status: string | null }>
  dependents: Array<{ id: string; title: string; status: string }>; log: string[]
}

const statusMeta: Record<Status, { label: string; dot: string; tone: string }> = {
  triage: { label: "Triage", dot: "bg-violet-500", tone: "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/60 dark:text-violet-300" },
  todo: { label: "Backlog", dot: "bg-slate-400", tone: "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300" },
  ready: { label: "Ready", dot: "bg-blue-500", tone: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/60 dark:text-blue-300" },
  running: { label: "In progress", dot: "bg-amber-500", tone: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-300" },
  review: { label: "Review", dot: "bg-cyan-500", tone: "border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-800 dark:bg-cyan-950/60 dark:text-cyan-300" },
  blocked: { label: "Blocked", dot: "bg-red-500", tone: "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/60 dark:text-red-300" },
  done: { label: "Done", dot: "bg-emerald-500", tone: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300" },
  archived: { label: "Archived", dot: "bg-slate-500", tone: "border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400" },
}
const actionLabels: Record<string, string> = {
  queue: "Queue", start: "Start", submit_review: "Submit review", approve: "Approve",
  request_changes: "Request changes", block: "Block", unblock: "Unblock", complete: "Complete",
  reopen: "Reopen", archive: "Archive",
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
  return body as T
}

function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"))
  const [projectId, setProjectId] = useState<string | null>(null)
  const [board, setBoard] = useState<Board | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [hubCsrf, setHubCsrf] = useState("")
  const [projectOpen, setProjectOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [soul, setSoul] = useState<{ name: string; soul: string; description: string } | null>(null)
  const [dispatchOpen, setDispatchOpen] = useState(false)
  const [dispatchPreview, setDispatchPreview] = useState<Record<string, unknown> | null>(null)
  const [tab, setTab] = useState("board")
  const [archive, setArchive] = useState<ArchivePage | null>(null)
  const api = projectApi(projectId)

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
    document.documentElement.style.colorScheme = dark ? "dark" : "light"
    localStorage.setItem("ab-theme", dark ? "dark" : "light")
  }, [dark])

  const loadProjects = useCallback(async () => {
    const data = await requestJson<{ projects: Project[]; activeProjectId: string | null; csrfToken: string }>("/api/projects")
    setProjects(data.projects)
    setHubCsrf(data.csrfToken)
    setProjectId((current) =>
      chooseProjectId(data.projects, current, localStorage.getItem("ab-project"), data.activeProjectId)
    )
  }, [])

  const loadBoard = useCallback(async (quiet = false) => {
    if (!projectId) return
    if (!quiet) setLoading(true)
    try {
      setBoard(await requestJson<Board>(`${api}/api/board`))
      setError(null)
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setLoading(false)
    }
  }, [api, projectId])

  const loadArchive = useCallback(async () => {
    if (!projectId) return
    try {
      setArchive(await requestJson<ArchivePage>(`${api}/api/archive?limit=100`))
      setError(null)
    } catch (caught) { setError((caught as Error).message) }
  }, [api, projectId])

  useEffect(() => { void loadProjects().catch((caught) => { setError(caught.message); setLoading(false) }) }, [loadProjects])
  useEffect(() => { if (tab === "archive") void loadArchive() }, [tab, loadArchive])
  useEffect(() => {
    if (!projectId) return
    localStorage.setItem("ab-project", projectId)
    setBoard(null); setDetail(null); setArchive(null)
    void loadBoard()
    const timer = window.setInterval(() => void loadBoard(true), 5_000)
    return () => window.clearInterval(timer)
  }, [projectId, loadBoard])

  const mutate = useCallback(async <T,>(path: string, payload: unknown): Promise<T> => {
    if (!board) throw new Error("Board is not loaded")
    return requestJson<T>(`${api}${path}`, {
      method: "POST", headers: { "x-ab-csrf": board.csrfToken }, body: JSON.stringify(payload),
    })
  }, [api, board])

  const openCard = async (card: BoardCard) => {
    try { setDetail(await requestJson<Detail>(`${api}/api/card/${encodeURIComponent(card.id)}?tail=120`)) }
    catch (caught) { setError((caught as Error).message) }
  }
  const createCard = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    try {
      await mutate("/api/add", {
        title: form.get("title"), body: form.get("body"), role: form.get("role") || null,
        priority: Number(form.get("priority") || 0), workspace: form.get("workspace"),
        mode: form.get("role") ? "ready" : "triage",
      })
      setCreateOpen(false); await loadBoard()
    } catch (caught) { setError((caught as Error).message) }
  }
  const registerBoard = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const root = String(new FormData(event.currentTarget).get("root") || "")
    try {
      const result = await requestJson<{ project: Project }>("/api/projects/register", {
        method: "POST", headers: { "x-ab-csrf": hubCsrf }, body: JSON.stringify({ root }),
      })
      await loadProjects(); setProjectId(result.project.id); setProjectOpen(false)
    } catch (caught) { setError((caught as Error).message) }
  }
  const patchCard = async (payload: unknown) => {
    if (!detail) return
    try {
      await mutate(`/api/card/${encodeURIComponent(detail.id)}/set`, payload)
      setDetail(await requestJson<Detail>(`${api}/api/card/${encodeURIComponent(detail.id)}?tail=120`))
      await loadBoard(true)
      if (archive) await loadArchive()
    } catch (caught) { setError((caught as Error).message) }
  }
  const reopenCard = async (id: string) => {
    try {
      await mutate(`/api/card/${encodeURIComponent(id)}/set`, { action: "reopen" })
      await loadArchive(); await loadBoard(true)
    } catch (caught) { setError((caught as Error).message) }
  }
  const previewDispatch = async () => {
    try { setDispatchPreview(await requestJson(`${api}/api/dispatch/preview`)); setDispatchOpen(true) }
    catch (caught) { setError((caught as Error).message) }
  }
  const startDispatch = async () => {
    if (!dispatchPreview) return
    try {
      await mutate("/api/dispatch", { fingerprint: dispatchPreview.fingerprint })
      setDispatchOpen(false); setDispatchPreview(null); await loadBoard(true)
    } catch (caught) { setError((caught as Error).message) }
  }

  const activeProject = projects.find((project) => project.id === projectId)
  const cards = useMemo(() => board ? board.columns.flatMap((status) => board.cards[status] || []) : [], [board])
  const shown = (status: Status) => (board?.cards[status] || []).filter((card) =>
    `${card.title} ${card.role || ""} ${card.short}`.toLowerCase().includes(query.toLowerCase())
  )
  return (
    <TooltipProvider>
      <div data-scroll-layout="fixed-sidebar" className="flex min-h-dvh items-stretch bg-background text-foreground transition-colors lg:h-dvh lg:overflow-hidden">
        <aside data-testid="project-sidebar" className="hidden h-dvh w-72 shrink-0 border-r bg-card lg:flex lg:flex-col">
          <div className="flex h-16 items-center gap-3 px-5">
            <div className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm"><Bot className="size-5" /></div>
            <div><div className="text-sm font-semibold tracking-tight">Agent Board</div><div className="text-xs text-muted-foreground">Autonomous workspace</div></div>
          </div>
          <Separator />
          <div className="flex min-h-0 flex-1 flex-col px-3 py-4">
            <div className="mb-2 flex items-center justify-between px-2">
              <span className="text-[11px] font-semibold uppercase tracking-[.16em] text-muted-foreground">Projects</span>
              <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => setProjectOpen(true)} aria-label="Add project" />}><Plus /></TooltipTrigger><TooltipContent>Register another project board</TooltipContent></Tooltip>
            </div>
            <nav className="sidebar-scroll min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">{projects.map((project) => (
              <button key={project.id} onClick={() => setProjectId(project.id)}
                className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition ${project.id === projectId ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
                <Avatar className="size-8 rounded-lg"><AvatarFallback className={`rounded-lg text-xs font-semibold ${project.id === projectId ? "bg-primary-foreground/15 text-primary-foreground" : ""}`}>{project.name.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{project.name}</span><span className={`block truncate text-[11px] ${project.id === projectId ? "text-primary-foreground/65" : "text-muted-foreground"}`}>{project.cards} cards · {project.running} active</span></span>
                {project.running > 0 && <span className="size-2 animate-pulse rounded-full bg-emerald-400" />}
              </button>
            ))}{projects.length === 0 && <div className="rounded-lg border border-dashed px-3 py-5 text-center text-xs leading-relaxed text-muted-foreground">No project boards yet.<br />Register one to get started.</div>}</nav>
          </div>
          <div className="px-4 pb-5"><Card className="gap-3 py-4 shadow-none"><CardContent className="space-y-3 px-4"><div className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-400" /> Local-first control</div><p className="text-xs leading-relaxed text-muted-foreground">Cards stay in each project. Runs are lease-protected and budget-gated.</p></CardContent></Card></div>
        </aside>

        <main data-testid="main-scroll" className="dashboard-scroll min-w-0 flex-1 lg:h-dvh lg:overflow-y-auto lg:overscroll-y-contain">
          <header className="sticky top-0 z-20 flex min-h-16 items-center gap-2 border-b bg-card px-3 py-2 shadow-[0_1px_0_rgba(15,23,42,.03)] md:gap-3 md:px-6 dark:shadow-black/20">
            <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" className="min-w-0 max-w-[11rem] gap-2 px-2 text-base font-semibold sm:max-w-xs" />}><Boxes className="size-4 shrink-0" /><span className="truncate">{activeProject?.name || "Select project"}</span><ChevronDown className="size-4 shrink-0 text-muted-foreground" /></DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-72"><DropdownMenuGroup><DropdownMenuLabel>Switch project</DropdownMenuLabel></DropdownMenuGroup><DropdownMenuSeparator />{projects.map((project) => <DropdownMenuItem key={project.id} onClick={() => setProjectId(project.id)} className="gap-3"><Avatar className="size-7 rounded-md"><AvatarFallback className="rounded-md text-[10px]">{project.name.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar><span className="min-w-0 flex-1"><span className="block truncate font-medium">{project.name}</span><span className="block truncate text-xs text-muted-foreground">{project.workdir}</span></span></DropdownMenuItem>)}</DropdownMenuContent>
            </DropdownMenu>
            <div className="relative ml-auto hidden w-48 md:block xl:w-64"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search cards…" aria-label="Search cards" className="h-9 bg-muted/60 pl-9" /></div>
            <Tooltip><TooltipTrigger render={<Button variant="outline" size="icon" onClick={() => setDark((value) => !value)} aria-label={dark ? "Use light theme" : "Use dark theme"} />}>{dark ? <Sun /> : <Moon />}</TooltipTrigger><TooltipContent>{dark ? "Use light theme" : "Use dark theme"}</TooltipContent></Tooltip>
            <Button className="hidden sm:inline-flex" variant="outline" size="icon" onClick={() => { void loadProjects(); void loadBoard() }} aria-label="Refresh"><RefreshCw className={loading ? "animate-spin" : ""} /></Button>
            <Button variant="outline" size="icon" className="sm:w-auto sm:px-3" onClick={() => void previewDispatch()} disabled={!board || board.readOnly || board.dispatching} aria-label={board?.dispatching ? "Dispatching" : "Dispatch"}><Rocket /><span className="hidden sm:inline">{board?.dispatching ? "Dispatching" : "Dispatch"}</span></Button>
            <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogTrigger render={<Button size="icon" className="sm:w-auto sm:px-3" disabled={!board || board.readOnly} aria-label="New card" />}><Plus /><span className="hidden sm:inline">New card</span></DialogTrigger>
              <DialogContent className="sm:max-w-xl"><form onSubmit={createCard}><DialogHeader><DialogTitle>Create work</DialogTitle><DialogDescription>Add an objective for this project. Leave role unassigned to let triage spec and route it.</DialogDescription></DialogHeader>
                <div className="grid gap-5 py-6"><div className="grid gap-2"><Label htmlFor="title">Objective</Label><Input id="title" name="title" required autoFocus placeholder="Implement project-scoped audit logs" /></div><div className="grid gap-2"><Label htmlFor="body">Definition of done</Label><Textarea id="body" name="body" rows={5} placeholder="Context, constraints, acceptance criteria…" /></div>
                  <div className="grid gap-3 sm:grid-cols-3"><div className="grid gap-2"><Label>Role</Label><Select name="role"><SelectTrigger><SelectValue placeholder="Auto-route" /></SelectTrigger><SelectContent>{board?.roles.map((role) => <SelectItem key={role.name} value={role.name}>{role.name}</SelectItem>)}</SelectContent></Select></div><div className="grid gap-2"><Label>Workspace</Label><Select name="workspace" defaultValue="repo"><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="repo">Repository</SelectItem><SelectItem value="worktree">Worktree</SelectItem><SelectItem value="scratch">Scratch</SelectItem></SelectContent></Select></div><div className="grid gap-2"><Label htmlFor="priority">Priority</Label><Input id="priority" name="priority" type="number" defaultValue="0" /></div></div>
                </div><DialogFooter><Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button><Button type="submit"><Sparkles />Create card</Button></DialogFooter></form></DialogContent>
            </Dialog>
          </header>

          <div className="px-4 py-5 pb-8 md:px-6">
            <div className="relative mb-4 md:hidden"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search cards…" aria-label="Search cards" className="h-10 bg-card pl-9" /></div>
            {error && <div className="mb-4 flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/60 dark:text-red-200"><span>{error}</span><Button variant="ghost" size="sm" onClick={() => setError(null)}>Dismiss</Button></div>}
            <div className="mb-5 grid grid-cols-3 gap-2 sm:gap-3">
              <Metric icon={<LayoutDashboard />} label="Open work" value={String(cards.filter((card) => card.status !== "done").length)} sub={`${cards.length} total cards`} />
              <Metric icon={<Activity />} label="Agents active" value={String(board?.cards.running?.length || 0)} sub={`${board?.caps.maxRunning || 0} concurrent cap`} live={Boolean(board?.cards.running?.length)} />
              <Metric icon={<Users />} label="Roles" value={String(board?.roles.length || 0)} sub="SOUL.md contracts" />
            </div>

            <Tabs value={tab} onValueChange={setTab}><div className="mb-4 flex items-center justify-between"><TabsList><TabsTrigger value="board"><LayoutDashboard />Board</TabsTrigger><TabsTrigger value="roles"><Users />Roles & souls</TabsTrigger><TabsTrigger value="archive" data-testid="archive-tab"><Archive />Archive</TabsTrigger></TabsList><div className="hidden max-w-xl truncate text-xs text-muted-foreground xl:block">{activeProject?.root}</div></div>
              <TabsContent value="board">{loading && !board ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[1,2,3,4].map((item) => <Skeleton key={item} className="h-96 rounded-xl" />)}</div> :
                <div data-testid="kanban-scroll" className="kanban-scroll -mx-1 overflow-x-auto px-1 pb-3" tabIndex={0} role="region" aria-label="Kanban board columns"><div className="flex min-w-max gap-3">{board?.columns.map((status) => <section key={status} className="w-[min(18.5rem,calc(100vw-2.5rem))] shrink-0 whitespace-normal sm:w-[296px]"><div className="mb-2 flex items-center gap-2 px-1"><span className={`size-2 rounded-full ${statusMeta[status].dot}`} /><h2 className="text-sm font-semibold">{statusMeta[status].label}</h2><Badge variant="secondary" className="ml-auto rounded-md">{shown(status).length}</Badge></div>
                  <div className="min-h-[clamp(22rem,calc(100dvh-22rem),42rem)] space-y-2 rounded-xl border bg-muted/55 p-2">{shown(status).map((card) => <button key={card.id} onClick={() => void openCard(card)} className="block w-full rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"><Card className="gap-3 py-4 shadow-[0_1px_2px_rgba(15,23,42,.04)] transition hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md dark:shadow-black/20"><CardContent className="px-4"><div className="mb-3 flex items-start justify-between gap-3"><Badge variant="outline" className={`rounded-md text-[10px] ${statusMeta[status].tone}`}>{card.short}</Badge>{card.priority > 0 && <span className="text-[10px] font-semibold text-amber-600 dark:text-amber-400">P{card.priority}</span>}</div><h3 className="mb-3 text-sm font-medium leading-snug text-foreground">{card.title}</h3>{card.blockedReason && <p className="mb-3 line-clamp-2 text-xs text-red-600 dark:text-red-400">{card.blockedReason}</p>}<div className="flex items-center gap-2 text-xs text-muted-foreground"><Avatar className="size-5"><AvatarFallback className="text-[8px]">{(card.role || "?").slice(0,2).toUpperCase()}</AvatarFallback></Avatar><span className="truncate">{card.role || "Unassigned"}</span>{card.leased && <Loader2 className="ml-auto size-3.5 animate-spin text-amber-600 dark:text-amber-400" />}</div></CardContent></Card></button>)}{shown(status).length === 0 && <div className="grid h-24 place-items-center text-xs text-muted-foreground">No cards</div>}</div>
                </section>)}</div></div>}</TabsContent>
              <TabsContent value="archive"><div data-testid="archive-view" className="space-y-3">
                <div className="flex items-center gap-3"><p className="text-sm text-muted-foreground">{archive ? `${archive.total} archived card${archive.total === 1 ? "" : "s"}${archive.total > archive.cards.length ? ` · showing the ${archive.cards.length} most recent` : ""}` : "Loading archive…"}</p><Button className="ml-auto" variant="outline" size="sm" onClick={() => void loadArchive()}><RefreshCw />Refresh</Button></div>
                {archive?.cards.length === 0 && <div className="rounded-xl border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">Nothing archived yet. Archive finished cards from their detail panel, or sweep them with <code>ab archive --done --yes</code>.</div>}
                <div className="grid gap-2">{archive?.cards.map((card) => <Card key={card.id} className="gap-0 py-3 shadow-none"><CardContent className="flex items-center gap-3 px-4"><Badge variant="outline" className={`rounded-md text-[10px] ${statusMeta.archived.tone}`}>{card.short}</Badge><button className="min-w-0 flex-1 text-left" onClick={() => void openCard(card)}><span className="block truncate text-sm font-medium">{card.title}</span><span className="block truncate text-xs text-muted-foreground">{card.role || "Unassigned"} · archived {new Date(card.updatedAt).toLocaleString()}</span></button><Button variant="outline" size="sm" disabled={!board || board.readOnly || card.leased} onClick={() => void reopenCard(card.id)}><RotateCcw />Reopen</Button></CardContent></Card>)}</div>
              </div></TabsContent>
              <TabsContent value="roles"><div className="grid items-stretch gap-3 sm:grid-cols-2 xl:grid-cols-3">{board?.roles.map((role) => <Card key={role.name} className="h-full shadow-none"><CardHeader><div className="flex items-center gap-3"><Avatar className="rounded-lg"><AvatarFallback className="rounded-lg"><Code2 className="size-4" /></AvatarFallback></Avatar><div><CardTitle className="text-base">{role.name}</CardTitle><p className="text-xs text-muted-foreground">{role.runtime} · {role.readOnly ? "read-only" : "write-capable"}</p></div></div></CardHeader><CardContent className="flex flex-1 flex-col"><p className="mb-4 text-sm leading-relaxed text-muted-foreground">{role.description}</p><Button className="mt-auto w-fit" variant="outline" size="sm" onClick={async () => setSoul(await requestJson(`${api}/api/role/${encodeURIComponent(role.name)}`))}>View SOUL.md</Button></CardContent></Card>)}</div></TabsContent>
            </Tabs>
          </div>
        </main>

        <Sheet open={Boolean(detail)} onOpenChange={(open) => !open && setDetail(null)}><SheetContent className="w-full overflow-y-auto p-0 sm:max-w-xl">{detail && <><SheetHeader className="border-b px-6 py-5"><div className="mb-2 flex items-center gap-2"><Badge variant="outline" className={statusMeta[detail.status].tone}>{statusMeta[detail.status].label}</Badge><span className="font-mono text-xs text-muted-foreground">{detail.id}</span></div><SheetTitle className="text-xl leading-tight">{detail.title}</SheetTitle><SheetDescription>{detail.runtime || "default runtime"} / {detail.model || "role default"} · {detail.workspace}</SheetDescription></SheetHeader>
          <div className="space-y-6 p-6"><div className="grid gap-2"><Label>Assigned role</Label><Select value={detail.role || "unassigned"} onValueChange={(role) => void patchCard({ role: role === "unassigned" ? null : role })} disabled={detail.leased}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="unassigned">Unassigned</SelectItem>{board?.roles.map((role) => <SelectItem key={role.name} value={role.name}>{role.name}</SelectItem>)}</SelectContent></Select></div><div><Label className="mb-2">Specification</Label><div className="rounded-lg border bg-muted/55 p-4 text-sm leading-relaxed whitespace-pre-wrap">{detail.body || "No specification yet."}</div></div><div className="grid grid-cols-2 gap-3"><Mini label="Tokens" value={detail.tokens.toLocaleString()} /><Mini label="Priority" value={String(detail.priority)} /></div>
            {detail.parents.length > 0 && <div><Label className="mb-2">Dependencies</Label><div className="space-y-2">{detail.dependencies.map((dependency) => <div key={dependency.id} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"><GitBranch className="size-4 text-muted-foreground" /><span className="truncate">{dependency.title || dependency.id}</span><Badge variant="secondary" className="ml-auto">{dependency.status || "missing"}</Badge></div>)}</div></div>}<div><Label className="mb-2">Lifecycle</Label><div className="flex flex-wrap gap-2">{detail.allowedActions.map((action) => <Button key={action} size="sm" variant={action === "approve" || action === "complete" ? "default" : action === "archive" ? "ghost" : "outline"} onClick={() => void patchCard({ action })} disabled={detail.leased}>{actionLabels[action] || action}</Button>)}</div></div>{detail.log.length > 0 && <div><Label className="mb-2">Latest agent output</Label><pre className="max-h-64 overflow-auto rounded-lg bg-slate-950 p-4 text-[11px] leading-relaxed text-slate-200">{detail.log.join("\n")}</pre></div>}</div></>}</SheetContent></Sheet>
        <Dialog open={Boolean(soul)} onOpenChange={(open) => !open && setSoul(null)}><DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{soul?.name} · SOUL.md</DialogTitle><DialogDescription>{soul?.description}</DialogDescription></DialogHeader><pre className="whitespace-pre-wrap rounded-lg border bg-muted/55 p-5 text-sm leading-relaxed">{soul?.soul}</pre></DialogContent></Dialog>
        <Dialog open={projectOpen} onOpenChange={setProjectOpen}><DialogContent><form onSubmit={registerBoard}><DialogHeader><DialogTitle>Add project board</DialogTitle><DialogDescription>Register an existing board root. Its cards and runtime state remain isolated in that project.</DialogDescription></DialogHeader><div className="grid gap-2 py-6"><Label htmlFor="project-root">Board root</Label><Input id="project-root" name="root" required autoFocus placeholder="/path/to/my-project" /><p className="text-xs text-muted-foreground">The path must already contain board/board.json. Use <code>ab init</code> first for a new project.</p></div><DialogFooter><Button type="button" variant="ghost" onClick={() => setProjectOpen(false)}>Cancel</Button><Button type="submit"><Plus />Register project</Button></DialogFooter></form></DialogContent></Dialog>
        <Dialog open={dispatchOpen} onOpenChange={setDispatchOpen}><DialogContent><DialogHeader><DialogTitle>Dispatch eligible work?</DialogTitle><DialogDescription>Agent Board will revalidate caps, leases, dependencies, and tracked-spend reservations before launching workers.</DialogDescription></DialogHeader><div className="rounded-lg border bg-muted/55 p-4 text-sm"><pre className="max-h-64 overflow-auto whitespace-pre-wrap">{JSON.stringify(dispatchPreview, null, 2)}</pre></div><DialogFooter><Button variant="ghost" onClick={() => setDispatchOpen(false)}>Cancel</Button><Button onClick={() => void startDispatch()}><Rocket />Start dispatch</Button></DialogFooter></DialogContent></Dialog>
      </div>
    </TooltipProvider>
  )
}

function Metric({ icon, label, value, sub, live = false }: { icon: React.ReactNode; label: string; value: string; sub: string; live?: boolean }) {
  return <Card className="gap-2 py-3 shadow-none sm:gap-3 sm:py-4"><CardContent className="px-3 sm:px-4"><div className="mb-2 flex min-h-8 items-start gap-1.5 text-[10px] font-medium leading-tight text-muted-foreground sm:mb-3 sm:min-h-0 sm:items-center sm:gap-2 sm:text-xs"><span className="shrink-0 [&>svg]:size-3.5 sm:[&>svg]:size-4">{icon}</span><span>{label}</span>{live && <span className="ml-auto size-2 shrink-0 animate-pulse rounded-full bg-emerald-500" />}</div><div className="text-xl font-semibold tracking-tight sm:text-2xl">{value}</div><p className="mt-1 hidden text-[11px] text-muted-foreground sm:block">{sub}</p></CardContent></Card>
}
function Mini({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border bg-muted/55 p-3"><p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-1 text-sm font-semibold">{value}</p></div>
}

export default App
