import { chart } from "./charts.ts";
import type { Point, Series } from "./charts.ts";

interface Run {
  id: string;
  status: string;
  queued_at: string;
  finished_at: string | null;
  found: number;
  checked: number;
  optimized: number;
  unchanged: number;
  failed: number;
  bytes_saved: number;
  policy_json: string;
  error: string | null;
}
interface Overview {
  library: { id: string; name: string; enabled: number };
  totals: {
    archives: number;
    currentBytes: number;
    savedBytes: number;
    optimizedArchives: number;
    optimizedPages: number;
    needsAttention: number;
  };
  current: Run | null;
  previous: Run | null;
  queued: number;
  progress: {
    stage: string;
    total: number;
    checked: number;
    fraction: number;
    startedAt: number;
  } | null;
  error: string | null;
}
interface Issue {
  id: number;
  archive_id: string | null;
  path: string | null;
  kind: string;
  message: string;
  state: string;
  note: string | null;
  location: string | null;
  status: string | null;
  lossy_state: string | null;
  created_at: string;
  details_json: string;
}
interface Result {
  id: number;
  archive_id: string | null;
  path: string;
  outcome: string;
  mode: string | null;
  source_size: number;
  final_size: number;
  bytes_saved: number;
  created_at: string;
  details_json: string;
}
interface Page {
  entry_path: string;
  outcome: string;
  source_format: string;
  mode: string | null;
  effort: number | null;
  distance: number | null;
  source_size: number;
  final_size: number;
  details_json: string;
}
interface Archive {
  id: string;
  path: string;
  location: string;
  status: string;
  lossy_state: string;
}
interface Settings {
  library: { name: string; enabled: number };
  effort: number;
  paths: {
    source: string;
    converted: string | null;
    quarantine: string | null;
  };
  limits: { threads: number; memoryMb: number };
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const dialog = $<HTMLDialogElement>("dialog"),
  dialogContent = $("dialog-content");
const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
const count = (value: number) => value.toLocaleString();
function bytes(value: number): string {
  if (!Number.isFinite(value)) return "Unknown";
  const absolute = Math.abs(value),
    units = ["B", "KB", "MB", "GB", "TB"],
    index =
      absolute < 1 ? 0 : Math.min(4, Math.floor(Math.log10(absolute) / 3));
  return (
    (value / 1000 ** index).toLocaleString(undefined, {
      maximumFractionDigits: index === 0 ? 0 : 1,
    }) +
    " " +
    units[index]
  );
}
const date = (value: string | null) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Date unavailable";
const label = (value: string) => value.replaceAll("_", " ");
function policyDescription(raw: string): string {
  try {
    const policy = JSON.parse(raw);
    if (policy.mode === "lossless" || policy.mode === "lossy")
      return (
        (policy.mode === "lossless"
          ? "Lossless"
          : "Lossy · distance " + policy.distance) +
        " · effort " +
        policy.effort
      );
  } catch {}
  return "Imported policy settings retained with this run";
}
let token = "",
  overview: Overview | null = null,
  online = false,
  chartKey = "",
  busy = false;
let issueState = "needs_review",
  issueOffset = 0;

function notice(message: string, modal = dialog.open) {
  const element = $(modal ? "dialog-notice" : "notice");
  element.textContent = message;
  element.hidden = !message;
}
async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch("/api/" + path, {
    method,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body !== undefined
        ? { "Content-Type": "application/json", "X-CBZXL-Request": "1" }
        : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) showLogin();
    throw new Error(data.error ?? "Request failed");
  }
  return data as T;
}
async function action(fn: () => Promise<void>) {
  if (busy) return;
  busy = true;
  notice("");
  try {
    await fn();
  } catch (error) {
    notice(error instanceof Error ? error.message : String(error));
  } finally {
    busy = false;
  }
}
function showDialog(title: string, html: string) {
  $("dialog-title").textContent = title;
  dialogContent.innerHTML = html;
  $("dialog-notice").hidden = true;
  if (!dialog.open) dialog.showModal();
  $("close-dialog").focus();
}
function showLogin() {
  if (dialog.open && dialogContent.querySelector("#login-form")) return;
  showDialog(
    "Connect to CBZXL",
    '<p class="caption">Enter the API token configured for this application.</p><form id="login-form" class="form review-form"><label class="field">API token<input name="token" type="password" autocomplete="current-password" required></label><div class="actions"><button class="primary">Connect</button></div></form>',
  );
}
function protection(archive: {
  lossy_state: string | null;
  location: string | null;
}): string {
  if (archive.lossy_state === "lossy")
    return "Previously lossy · lossy blocked";
  if (archive.lossy_state === "unknown")
    return "Uncertain history · lossy blocked";
  if (archive.location === "quarantine") return "Original in quarantine";
  return archive.location === "source"
    ? "Original kept"
    : archive.location === "converted"
      ? "Verified output retained"
      : "Re-review required";
}
function renderOverview(data: Overview) {
  overview = data;
  $("library-name").textContent = data.library.name;
  const progress = data.progress,
    current = data.current;
  let stage = "Ready to convert",
    eta = "",
    fraction = 0;
  if (current && progress) {
    stage = current.status === "stopping" ? "Stopping safely" : progress.stage;
    const done = progress.checked + progress.fraction;
    fraction = progress.total
      ? Math.min(100, (done / progress.total) * 100)
      : 0;
    if (progress.total && done >= 1) {
      const remaining =
        ((Date.now() - progress.startedAt) / 1000 / done) *
        Math.max(0, progress.total - done);
      eta =
        remaining < 60
          ? "Less than a minute remaining"
          : "About " + Math.ceil(remaining / 60) + " min remaining";
    } else eta = "Estimating time remaining";
  } else if (data.queued) {
    stage = "Run queued";
  } else if (!data.library.enabled) {
    stage = "Library paused";
  } else if (data.previous) {
    stage =
      data.previous.status === "succeeded"
        ? "Ready for the next run"
        : data.previous.status === "cancelled"
          ? "Stopped safely"
          : data.previous.status === "partial"
            ? "Run finished with items to review"
            : "Previous run interrupted";
    fraction = ["succeeded", "partial"].includes(data.previous.status)
      ? 100
      : data.previous.found
        ? (100 * data.previous.checked) / data.previous.found
        : 0;
  }
  $("stage").textContent = stage;
  $("eta").textContent = eta;
  $("run-count").textContent = progress?.total
    ? " · " +
      count(progress.checked) +
      " of " +
      count(progress.total) +
      " complete"
    : data.queued
      ? " · " + data.queued + " queued"
      : "";
  $<HTMLProgressElement>("progress").value = fraction;
  const button = $<HTMLButtonElement>("run-button");
  button.textContent = current ? "Stop" : "Start";
  button.disabled =
    !online ||
    (!current && !data.library.enabled) ||
    current?.status === "stopping";
  button.setAttribute(
    "aria-label",
    current ? "Stop run safely" : "Start a lossless run",
  );
  $("saved").textContent = bytes(data.totals.savedBytes);
  $("pages").textContent = count(data.totals.optimizedPages);
  $("archives").textContent = count(data.totals.optimizedArchives);
  $("archive-count").textContent =
    "of " + count(data.totals.archives) + " archives";
  $("attention").textContent = count(data.totals.needsAttention);
  $("attention-button").setAttribute(
    "aria-label",
    "Open " + data.totals.needsAttention + " items needing attention",
  );
  const previous = data.previous;
  $("previous").textContent = previous
    ? "Previous run: " +
      label(previous.status) +
      " · " +
      date(previous.finished_at) +
      " · " +
      count(previous.checked) +
      " archives · " +
      bytes(previous.bytes_saved) +
      " saved"
    : "No previous runs · View queue";
}
async function trends() {
  const data = await api<{ since: string; until: string; points: Point[] }>(
    "trends?days=" + $<HTMLSelectElement>("range").value,
  );
  chart(
    $("size-chart"),
    data.points,
    [
      {
        name: "Library size",
        color: "#4d7ce8",
        value: (p) => (p.current_bytes === null ? null : p.current_bytes / 1e9),
      },
      {
        name: "Cumulative savings",
        color: "#26978d",
        value: (p) => (p.saved_bytes === null ? null : p.saved_bytes / 1e9),
      },
    ],
    "GB",
    data.since,
    data.until,
  );
  const colors = [
    "#4d7ce8",
    "#d48a2e",
    "#26978d",
    "#a275c6",
    "#c46c82",
    "#7d8796",
  ];
  const formats: Series[] = [
    "JPEG XL",
    "JPEG",
    "PNG",
    "TIFF",
    "BMP",
    "Other",
  ].map((name, index) => ({
    name,
    color: colors[index]!,
    value: (point) => {
      if (!point.formats) return null;
      if (name === "Other")
        return Object.entries(point.formats)
          .filter(
            ([key]) => !["JPEG XL", "JPEG", "PNG", "TIFF", "BMP"].includes(key),
          )
          .reduce((sum, [, n]) => sum + n, 0);
      return point.formats[name] ?? 0;
    },
  }));
  chart(
    $("format-chart"),
    data.points,
    formats,
    "Images",
    data.since,
    data.until,
  );
}
async function refresh() {
  const data = await api<Overview>("overview");
  online = true;
  renderOverview(data);
  const key = JSON.stringify([
    data.totals,
    data.current?.id,
    data.previous?.id,
  ]);
  if (key !== chartKey) {
    await trends();
    chartKey = key;
  }
  notice(data.error ?? "", false);
}
async function poll() {
  try {
    await refresh();
  } catch (error) {
    online = false;
    $<HTMLButtonElement>("run-button").disabled = true;
    $("eta").textContent = "Connection unavailable · showing last known state";
    notice(error instanceof Error ? error.message : String(error), false);
  }
  setTimeout(() => void poll(), overview?.current ? 1500 : 5000);
}
async function issues() {
  const { items } = await api<{ items: Issue[] }>(
    "issues?state=" + issueState + "&offset=" + issueOffset,
  );
  showDialog(
    "Needs attention",
    '<p class="caption">Review items are retained across runs. Viewing them changes nothing.</p><div class="dialog-nav"><select id="issue-filter" aria-label="Review filter"><option value="needs_review"' +
      (issueState === "needs_review" ? " selected" : "") +
      '>Needs review</option><option value="all"' +
      (issueState === "all" ? " selected" : "") +
      ">All review history</option></select></div>" +
      (items.length
        ? '<table class="table"><colgroup><col width="29%"><col width="46%"><col width="25%"></colgroup><thead><tr><th>Archive</th><th>What happened</th><th>Protection</th></tr></thead><tbody>' +
          items
            .map(
              (item) =>
                '<tr><td><button class="archive-name" data-issue="' +
                item.id +
                '">' +
                escape(item.path ?? "Imported history") +
                '</button><p class="meta">' +
                escape(date(item.created_at)) +
                "</p></td><td>" +
                escape(label(item.kind)) +
                '<p class="meta">' +
                escape(item.message) +
                "</p>" +
                (item.state !== "needs_review"
                  ? '<p class="meta">Reviewed</p>'
                  : "") +
                '</td><td><span class="protection">' +
                escape(protection(item)) +
                "</span></td></tr>",
            )
            .join("") +
          "</tbody></table>"
        : '<p class="empty">No items in this view.</p>') +
      pagination("issues", issueOffset, items.length),
  );
  for (const button of dialogContent.querySelectorAll<HTMLButtonElement>(
    "[data-issue]",
  ))
    button.addEventListener(
      "click",
      () =>
        void action(() =>
          review(
            items.find((item) => String(item.id) === button.dataset.issue)!,
          ),
        ),
    );
}
function pagination(name: string, offset: number, length: number) {
  return (
    '<div class="actions">' +
    (offset
      ? '<button class="quiet" data-page="' +
        name +
        '" data-offset="' +
        Math.max(0, offset - 50) +
        '">Previous</button>'
      : "") +
    (length === 50
      ? '<button class="quiet" data-page="' +
        name +
        '" data-offset="' +
        (offset + 50) +
        '">Next</button>'
      : "") +
    "</div>"
  );
}
async function review(issue: Issue) {
  const canRetry =
    issue.archive_id &&
    issue.location !== "quarantine" &&
    issue.status !== "missing";
  showDialog(
    "Review item",
    '<div class="actions"><button class="quiet" data-action="issues">All attention items</button></div><h3 class="detail-title">' +
      escape(issue.path ?? "Imported history") +
      '</h3><p class="caption protection">' +
      escape(protection(issue)) +
      '</p><p class="message">' +
      escape(issue.message) +
      '</p><p class="caption">' +
      escape(label(issue.kind)) +
      " · " +
      escape(date(issue.created_at)) +
      "</p>" +
      (issue.note
        ? '<p class="message review-note">Previous note: ' +
          escape(issue.note) +
          "</p>"
        : "") +
      '<form id="review-form" class="form review-form" data-id="' +
      issue.id +
      '"><label class="field">Review note<textarea name="note" maxlength="4000" required></textarea></label><p class="caption">Marking this item reviewed keeps its history and lossy-conversion protection.</p><div class="actions"><button class="primary">' +
      (issue.state === "needs_review" ? "Mark reviewed" : "Reopen for review") +
      "</button>" +
      (canRetry
        ? '<button type="button" class="quiet" data-retry="' +
          escape(issue.archive_id) +
          '">Retry losslessly</button>'
        : "") +
      (issue.archive_id
        ? '<button type="button" class="quiet" data-archive="' +
          escape(issue.archive_id) +
          '">Conversion history</button>'
        : "") +
      '</div><input type="hidden" name="state" value="' +
      (issue.state === "needs_review" ? "reviewed" : "needs_review") +
      '"></form>',
  );
}
async function runs(offset = 0) {
  const { items } = await api<{ items: Run[] }>("runs?offset=" + offset);
  showDialog(
    "Runs",
    '<p class="caption">Current queue and retained run history.</p>' +
      (items.length
        ? '<table class="table"><thead><tr><th>Run</th><th>Archives</th><th>Space saved</th></tr></thead><tbody>' +
          items
            .map(
              (run) =>
                '<tr><td><button class="archive-name" data-run="' +
                escape(run.id) +
                '">' +
                escape(label(run.status)) +
                '</button><p class="meta">' +
                escape(date(run.queued_at)) +
                "</p>" +
                (["queued", "running", "stopping"].includes(run.status)
                  ? '<button class="quiet" data-cancel="' +
                    escape(run.id) +
                    '">Cancel</button>'
                  : "") +
                "</td><td>" +
                count(run.checked) +
                ' checked<p class="meta">' +
                count(run.optimized) +
                " optimized · " +
                count(run.failed) +
                " need review</p></td><td>" +
                bytes(run.bytes_saved) +
                "</td></tr>",
            )
            .join("") +
          "</tbody></table>"
        : '<p class="empty">No runs yet. Start a lossless run from the overview.</p>') +
      pagination("runs", offset, items.length),
  );
}
async function runDetails(id: string, offset = 0) {
  const data = await api<{ run: Run; results: Result[] }>(
    "runs/" + encodeURIComponent(id) + "?offset=" + offset,
  );
  showDialog(
    "Run details",
    '<div class="actions"><button class="quiet" data-action="runs">All runs</button></div><p class="caption">' +
      escape(label(data.run.status)) +
      " · " +
      escape(date(data.run.finished_at ?? data.run.queued_at)) +
      "</p>" +
      (data.run.error
        ? '<p class="message">' + escape(data.run.error) + "</p>"
        : "") +
      '<p class="caption">' +
      escape(policyDescription(data.run.policy_json)) +
      "</p>" +
      resultsTable(data.results) +
      pagination("run:" + id, offset, data.results.length),
  );
}
function resultsTable(results: Result[]): string {
  return results.length
    ? '<table class="table"><thead><tr><th>Archive</th><th>Outcome</th><th>Space saved</th></tr></thead><tbody>' +
        results
          .map(
            (item) =>
              "<tr><td>" +
              (item.archive_id
                ? '<button class="archive-name" data-archive="' +
                  escape(item.archive_id) +
                  '">' +
                  escape(item.path) +
                  "</button>"
                : escape(item.path)) +
              "</td><td>" +
              escape(label(item.outcome)) +
              '<p class="meta">' +
              escape(item.mode ?? "Mode not recorded") +
              "</p></td><td>" +
              bytes(item.bytes_saved) +
              "</td></tr>",
          )
          .join("") +
        "</tbody></table>"
    : '<p class="empty">No archive results recorded for this run.</p>';
}
async function archiveDetails(id: string, offset = 0) {
  const data = await api<{
    archive: Archive;
    results: Result[];
    pages: Page[];
  }>("archives/" + encodeURIComponent(id) + "?offset=" + offset);
  showDialog(
    "Conversion history",
    '<h3 class="detail-title">' +
      escape(data.archive.path) +
      '</h3><p class="caption">' +
      escape(data.archive.location) +
      " · " +
      escape(protection(data.archive)) +
      "</p>" +
      resultsTable(data.results) +
      (data.pages.length
        ? '<table class="table"><thead><tr><th>Page</th><th>Outcome and settings</th><th>Size</th></tr></thead><tbody>' +
          data.pages
            .map(
              (page) =>
                "<tr><td>" +
                escape(page.entry_path) +
                '<p class="meta">' +
                escape(page.source_format) +
                "</p></td><td>" +
                escape(page.outcome) +
                '<p class="meta">' +
                escape(page.mode ?? "Mode not recorded") +
                (page.effort !== null ? " · effort " + page.effort : "") +
                (page.distance !== null ? " · distance " + page.distance : "") +
                "</p></td><td>" +
                bytes(page.source_size) +
                " → " +
                bytes(page.final_size) +
                "</td></tr>",
            )
            .join("") +
          "</tbody></table>"
        : '<p class="empty">No per-page history is available.</p>') +
      pagination(
        "archive:" + id,
        offset,
        Math.max(data.pages.length, data.results.length),
      ),
  );
}
async function settings() {
  const data = await api<Settings>("settings");
  $("overview").hidden = true;
  $("settings").hidden = false;
  $("settings").innerHTML =
    '<button class="quiet back" data-action="overview">Overview</button><h2 id="settings-title" class="settings-heading">Settings</h2><p class="caption">Every ordinary run starts lossless. Existing JPEG XL images stay unchanged.</p><form id="settings-form" class="form"><label class="field">Library name<input name="name" required maxlength="100" value="' +
    escape(data.library.name) +
    '"></label><label class="field"><span class="effort-label">Encoder effort<output id="effort-value">' +
    data.effort +
    '</output></span><input name="effort" type="range" min="1" max="10" value="' +
    data.effort +
    '"></label><label class="check wide"><input name="enabled" type="checkbox"' +
    (data.library.enabled ? " checked" : "") +
    '>Enable new runs</label><div class="actions wide"><button class="primary">Save settings</button></div></form><section class="settings-section"><h3>Directories &amp; resources</h3><p class="caption">Set these in .env, then restart CBZXL.</p><div class="form"><label class="field wide">Source<input readonly value="' +
    escape(data.paths.source) +
    '"></label><label class="field">Converted<input readonly value="' +
    escape(data.paths.converted ?? "Disabled · replace source in place") +
    '"></label><label class="field">Quarantine<input readonly value="' +
    escape(data.paths.quarantine ?? "Disabled · keep originals in source") +
    '"></label><p class="caption wide">' +
    data.limits.threads +
    " CPU threads · " +
    count(data.limits.memoryMb) +
    ' MB processing budget</p></div></section><section class="settings-section"><h3>Run options</h3><p class="caption">Choose settings for one run. The overview continues to default to lossless.</p><form id="options-form" class="form"><label class="field">Archives<select name="scope"><option value="changed">New, changed, or unsuccessful</option><option value="all">All source archives</option></select></label><label class="field">Mode<select name="mode" id="mode"><option value="lossless">Lossless</option><option value="lossy">Lossy</option></select></label><label class="field" id="distance-field" hidden>Lossy distance<input name="distance" type="number" min="0.1" max="3" step="0.1" value="0.5"></label><p class="caption wide" id="lossy-note" hidden>Lossy conversion changes image content. Archives with uncertain or previously lossy history remain blocked.</p><div class="actions wide"><button class="primary">Start this run</button></div></form></section>';
}
async function start(body: unknown = {}) {
  await api("runs", "POST", body);
  await refresh();
}
$("run-button").addEventListener(
  "click",
  () =>
    void action(async () => {
      if (overview?.current)
        await api("runs/" + overview.current.id + "/cancel", "POST", {});
      else await start();
      await refresh();
    }),
);
$("attention-button").addEventListener(
  "click",
  () =>
    void action(async () => {
      issueOffset = 0;
      issueState = "needs_review";
      await issues();
    }),
);
$("previous").addEventListener("click", () => void action(() => runs()));
$("settings-button").addEventListener(
  "click",
  () => void action(() => settings()),
);
$("range").addEventListener("change", () => void action(() => trends()));
$("close-dialog").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) {
    const box = dialog.getBoundingClientRect();
    if (
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    )
      dialog.close();
  }
});
document.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement;
  if (target.name === "effort") $("effort-value").textContent = target.value;
});
document.addEventListener("change", (event) => {
  const target = event.target as HTMLSelectElement;
  if (target.id === "issue-filter") {
    issueState = target.value;
    issueOffset = 0;
    void action(() => issues());
  }
  if (target.id === "mode") {
    $("distance-field").hidden = target.value !== "lossy";
    $("lossy-note").hidden = target.value !== "lossy";
  }
});
document.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button");
  if (!button) return;
  const data = button.dataset;
  if (data.action === "overview") {
    $("settings").hidden = true;
    $("overview").hidden = false;
    return;
  }
  if (data.action === "issues") void action(() => issues());
  if (data.action === "runs") void action(() => runs());
  if (data.run) void action(() => runDetails(data.run!));
  if (data.archive) void action(() => archiveDetails(data.archive!));
  if (data.retry)
    void action(async () => {
      await start({ archiveId: data.retry, policy: { mode: "lossless" } });
      notice("A lossless retry is queued. This review item remains open.");
    });
  if (data.cancel)
    void action(async () => {
      await api("runs/" + data.cancel + "/cancel", "POST", {});
      await runs();
      await refresh();
    });
  if (data.page)
    void action(async () => {
      const offset = Number(data.offset);
      if (data.page === "issues") {
        issueOffset = offset;
        await issues();
      } else if (data.page === "runs") await runs(offset);
      else if (data.page!.startsWith("run:"))
        await runDetails(data.page!.slice(4), offset);
      else await archiveDetails(data.page!.slice(8), offset);
    });
});
document.addEventListener("submit", (event) => {
  const form = event.target as HTMLFormElement;
  if (
    !["login-form", "settings-form", "options-form", "review-form"].includes(
      form.id,
    )
  )
    return;
  event.preventDefault();
  const values = new FormData(form);
  void action(async () => {
    if (form.id === "login-form") {
      token = String(values.get("token"));
      await refresh();
      dialog.close();
    }
    if (form.id === "settings-form") {
      await api("settings", "PATCH", {
        name: values.get("name"),
        effort: Number(values.get("effort")),
        enabled: values.get("enabled") === "on",
      });
      await refresh();
      notice("Settings saved.", false);
    }
    if (form.id === "options-form") {
      await start({
        scope: values.get("scope"),
        policy: {
          mode: values.get("mode"),
          distance: Number(values.get("distance")),
        },
      });
      $("settings").hidden = true;
      $("overview").hidden = false;
    }
    if (form.id === "review-form") {
      await api("issues/" + form.dataset.id, "PATCH", {
        state: values.get("state"),
        note: values.get("note"),
      });
      await issues();
      await refresh();
    }
  });
});
void poll();
