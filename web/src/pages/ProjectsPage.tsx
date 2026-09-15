/**
 * Projects: register a local project and launch an autonomous assessment.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §F. A project is a name and the path to a folder
 * on the machine running the server. Registering one lets AGENTIQ discover its
 * routes, start it, test it, scan it and judge its readiness, with no URL typed.
 *
 * The workspace path is deliberately plain text: the server holds the filesystem
 * jail, and a path outside it is refused there, not hidden here.
 */
import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { FolderPlus, FolderUp, Play, FolderGit2, Clock, KeyRound, FileDown } from 'lucide-react';
import {
  useProjects, useCreateProject, useUploadProject, useUpdateProjectEnv, useImportProjectEnv,
  useAssessments, useCreateAssessment, useHealth,
} from '@/hooks/api';
import {
  Card, CardHeader, CardBody, Button, Field, Input, Textarea, Alert, Chip, EmptyState, SkeletonRows,
} from '@/components/ui';
import { ApiError } from '@/services/api';
import type { AssessState } from '@/types';

/** KEY=VALUE per line -> an object. Blank lines and #comments ignored. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

// What a folder upload leaves behind: build output and binaries are worthless to
// a source scan and would blow the size budget, so they are dropped in the
// browser before anything is uploaded.
const UPLOAD_IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', '.nyc_output',
  '.cache', '.turbo', '.parcel-cache', 'vendor', '__pycache__', '.venv', 'venv',
  '.idea', '.vscode', '.svelte-kit', 'target', 'bin', 'obj',
]);
const UPLOAD_BINARY_RE = /\.(png|jpe?g|gif|webp|ico|bmp|svg|pdf|zip|gz|tgz|tar|rar|7z|mp4|mov|avi|mkv|mp3|wav|flac|woff2?|ttf|eot|otf|bin|exe|dll|so|dylib|class|jar|wasm|lock|map|node|psd|sqlite|db)$/i;
const UPLOAD_MAX_FILE_BYTES = 512 * 1024;
const UPLOAD_MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const UPLOAD_MAX_FILES = 3000;

/**
 * Reads a folder the user picked into the [{ path, content }] list the upload
 * endpoint expects. Build output and binaries are skipped, the top-level folder
 * name is stripped so paths are project-root relative, and the same caps the
 * server enforces are applied here so an over-large folder fails fast in the UI.
 */
export async function readPickedFolder(
  fileList: FileList,
): Promise<{ name: string; files: { path: string; content: string }[]; skipped: number }> {
  const all = Array.from(fileList);
  const topName = all[0]?.webkitRelativePath?.split('/')[0] || 'project';
  const files: { path: string; content: string }[] = [];
  let total = 0;
  let skipped = 0;
  for (const f of all) {
    const rel = f.webkitRelativePath || f.name;
    const parts = rel.split('/');
    if (parts.some((p) => UPLOAD_IGNORED_DIRS.has(p)) || UPLOAD_BINARY_RE.test(f.name) || f.size > UPLOAD_MAX_FILE_BYTES) {
      skipped += 1;
      continue;
    }
    if (files.length >= UPLOAD_MAX_FILES) break;
    const projPath = parts.slice(1).join('/') || f.name; // strip the picked folder itself
    if (!projPath) continue;
    // eslint-disable-next-line no-await-in-loop
    const content = await f.text();
    total += content.length;
    if (total > UPLOAD_MAX_TOTAL_BYTES) break;
    files.push({ path: projPath, content });
  }
  return { name: topName, files, skipped };
}

// Non-standard attributes that turn a file input into a folder picker. Typed as
// a loose object because they are not in React's JSX types.
const FOLDER_PICKER_PROPS = { webkitdirectory: '', directory: '', mozdirectory: '' } as Record<string, string>;

const ASSESS_CHIP: Record<string, string> = {
  COMPLETE: 'bg-success-50 text-success',
  FAILED: 'bg-danger-50 text-danger',
  AWAITING_INPUT: 'bg-warning-50 text-warning',
  PENDING: 'bg-surface-3 text-ink-muted',
};

export function AssessChip({ state }: { state: AssessState }) {
  return <Chip className={ASSESS_CHIP[state] ?? 'bg-info-50 text-info'}>{state.replace(/_/g, ' ')}</Chip>;
}

export function ProjectsPage() {
  const navigate = useNavigate();
  // On the shared hosted site the server can't see a visitor's laptop, so the
  // local-folder workflow is hidden and only a deployed URL or GitHub repo work.
  const hosted = useHealth().data?.hosted ?? false;
  const projects = useProjects();
  const create = useCreateProject();
  const upload = useUploadProject();
  const folderRef = useRef<HTMLInputElement>(null);
  const updateEnv = useUpdateProjectEnv();
  const importEnv = useImportProjectEnv();
  const runAssessment = useCreateAssessment();
  const recent = useAssessments();

  const [name, setName] = useState('');
  const [root, setRoot] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [envText, setEnvText] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Which project's env editor is open, and its draft text.
  const [editEnvFor, setEditEnvFor] = useState<string | null>(null);
  const [editEnvText, setEditEnvText] = useState('');

  const submit = async () => {
    setError(null);
    try {
      const runtimeEnv = parseEnv(envText);
      await create.mutateAsync({
        name: name.trim(),
        ...(root.trim() ? { workspaceRoot: root.trim() } : {}),
        ...(targetUrl.trim() ? { targetUrl: targetUrl.trim() } : {}),
        ...(repoUrl.trim() ? { repoUrl: repoUrl.trim() } : {}),
        ...(Object.keys(runtimeEnv).length ? { runtimeEnv } : {}),
      });
      setName('');
      setRoot('');
      setTargetUrl('');
      setRepoUrl('');
      setEnvText('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add the project.');
    }
  };

  const onPickFolder = async (e: ChangeEvent<HTMLInputElement>) => {
    setError(null);
    const list = e.target.files;
    if (!list || list.length === 0) return;
    try {
      const { name: folderName, files, skipped } = await readPickedFolder(list);
      if (files.length === 0) {
        setError(`No readable source files in that folder (${skipped} build/binary files were skipped).`);
        return;
      }
      await upload.mutateAsync({ name: name.trim() || folderName, files });
      setName('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not upload the folder.');
    } finally {
      if (folderRef.current) folderRef.current.value = ''; // let the same folder be picked again
    }
  };

  const saveEnv = async (projectId: string) => {
    setError(null);
    try {
      await updateEnv.mutateAsync({ id: projectId, runtimeEnv: parseEnv(editEnvText) });
      setEditEnvFor(null);
      setEditEnvText('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the environment.');
    }
  };

  const loadFromFile = async (projectId: string) => {
    setError(null);
    try {
      await importEnv.mutateAsync({ id: projectId });
      setEditEnvFor(null);
      setEditEnvText('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not read the project .env file.');
    }
  };

  const start = async (projectId: string) => {
    setError(null);
    try {
      const { assessment } = await runAssessment.mutateAsync({ projectId });
      navigate(`/assessments/${assessment._id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the assessment.');
    }
  };

  const list = projects.data?.projects ?? [];
  const recents = recent.data?.assessments ?? [];

  return (
    <div className="max-w-4xl space-y-4">
      <div>
        <h1 className="t-h1">Projects</h1>
        <p className="t-small mt-1 text-ink-muted">
          Upload a folder from your computer, give a deployed URL, or point at a public GitHub repo.
          AGENTIQ discovers the routes, scans for security issues, and judges whether it is ready to deploy.
        </p>
      </div>

      {error && <Alert tone="danger" title="Something went wrong">{error}</Alert>}

      <Card>
        <CardHeader title="Add a project" />
        <CardBody>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <Field label="Name" htmlFor="proj-name" required>
              <Input id="proj-name" required placeholder="my-api"
                value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <p className="t-small text-ink-muted">
              Choose any one: upload a folder from your computer, give a deployed URL, or point at a public
              GitHub repo. An uploaded folder or a cloned repo is statically scanned and never run; a deployed
              URL is probed live. Its functional tests run only when you run AGENTIQ on your own machine.
            </p>
            <Field label="Upload a folder from your computer" htmlFor="proj-folder"
              hint="Pick your project folder. Its source is uploaded and scanned for issues; node_modules, build output and binaries are skipped, and the code is never run.">
              <div className="flex flex-wrap items-center gap-2">
                <input ref={folderRef} id="proj-folder" type="file" multiple hidden
                  onChange={(e) => void onPickFolder(e)} {...FOLDER_PICKER_PROPS} />
                <Button type="button" variant="secondary" loading={upload.isPending}
                  onClick={() => folderRef.current?.click()}>
                  <FolderUp size={16} aria-hidden /> Choose folder
                </Button>
                <span className="t-small text-ink-subtle">Scans as soon as it uploads. No install needed.</span>
              </div>
            </Field>
            {!hosted && (
              <Field label="Or a folder path on this machine" htmlFor="proj-root"
                hint="An absolute path to a project folder on the machine running AGENTIQ. Local runs only; it also lets AGENTIQ start the app and run functional tests.">
                <Input id="proj-root" mono placeholder="/Users/you/code/my-api"
                  value={root} onChange={(e) => setRoot(e.target.value)} />
              </Field>
            )}
            <Field label={hosted ? 'Deployed URL' : 'Deployed URL (optional)'} htmlFor="proj-url"
              hint="A live https URL, e.g. https://my-app.vercel.app. Security probes run against it directly. Functional tests are skipped on a live app so it is never sent test writes.">
              <Input id="proj-url" mono placeholder="https://my-app.vercel.app"
                value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} />
            </Field>
            <Field label="GitHub repository (optional)" htmlFor="proj-repo"
              hint="A public repo, e.g. https://github.com/owner/repo. AGENTIQ clones it and runs discovery and the static security scans. It never runs the cloned code.">
              <Input id="proj-repo" mono placeholder="https://github.com/owner/repo"
                value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} />
            </Field>
            {!hosted && (
              <Field label="Runtime environment (optional)" htmlFor="proj-env"
                hint="KEY=VALUE per line. Only if the app needs it to start (a database URL, a secret). Stored locally on the server, never sent back to the browser. Cannot override PORT.">
                <Textarea id="proj-env" mono rows={3} placeholder={'MONGO_URI=mongodb://localhost:27017/app\nJWT_SECRET=…'}
                  value={envText} onChange={(e) => setEnvText(e.target.value)} />
              </Field>
            )}
            <Button type="submit" loading={create.isPending} disabled={!name.trim() || (!root.trim() && !targetUrl.trim() && !repoUrl.trim())}>
              <FolderPlus size={16} aria-hidden /> Add project
            </Button>
          </form>
        </CardBody>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="Your projects" />
        {projects.isLoading && <CardBody><SkeletonRows rows={2} /></CardBody>}
        {!projects.isLoading && list.length === 0 && (
          <EmptyState
            icon={<FolderGit2 size={36} strokeWidth={1.5} />}
            title="No projects yet"
            body="Add a project above to run your first autonomous assessment."
          />
        )}
        {list.length > 0 && (
          <div className="divide-y divide-line">
            {list.map((p) => (
              <div key={p.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium text-ink">{p.name}</p>
                    <p className="t-mono truncate text-[12px] text-ink-muted">{p.repoUrl ?? p.workspaceRoot ?? p.targetUrl}</p>
                  </div>
                  {p.repoUrl && (
                    <Chip className="bg-surface-3 text-ink-muted">github</Chip>
                  )}
                  {p.cloneStatus === 'cloning' && (
                    <Chip className="bg-info-50 text-info">
                      <span aria-hidden className="size-2.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                      cloning…
                    </Chip>
                  )}
                  {p.cloneStatus === 'failed' && (
                    <Chip className="bg-danger-50 text-danger">clone failed</Chip>
                  )}
                  {p.targetUrl && (
                    <Chip className="bg-info-50 text-info">deployed</Chip>
                  )}
                  {p.runtimeEnvKeys && p.runtimeEnvKeys.length > 0 && (
                    <Chip className="bg-surface-3 text-ink-subtle">env: {p.runtimeEnvKeys.join(', ')}</Chip>
                  )}
                  <span className="t-small text-ink-subtle">
                    {p.lastDiscoveryAt
                      ? `discovered ${new Date(p.lastDiscoveryAt).toLocaleDateString()}`
                      : 'not discovered yet'}
                  </span>
                  <Button size="sm" variant="secondary"
                    onClick={() => { setEditEnvFor(editEnvFor === p.id ? null : p.id); setEditEnvText(''); }}>
                    <KeyRound size={14} aria-hidden /> Env
                  </Button>
                  <Button size="sm" loading={runAssessment.isPending}
                    disabled={p.cloneStatus === 'cloning' || p.cloneStatus === 'failed'}
                    onClick={() => void start(p.id)}>
                    <Play size={15} aria-hidden /> Run assessment
                  </Button>
                </div>
                {p.cloneStatus === 'failed' && p.cloneError && (
                  <p className="t-small mt-2 text-danger">Clone failed: {p.cloneError}</p>
                )}
                {editEnvFor === p.id && (
                  <div className="mt-3 space-y-3 rounded-[6px] border border-line bg-surface-2 p-3">
                    {p.workspaceRoot && (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" variant="secondary" loading={importEnv.isPending}
                          onClick={() => void loadFromFile(p.id)}>
                          <FileDown size={14} aria-hidden /> Load from project's .env
                        </Button>
                        <span className="t-small text-ink-subtle">
                          Reads the .env in the project folder on the server. The values are stored, never shown here.
                        </span>
                      </div>
                    )}
                    <p className="t-small text-ink-muted">
                      Or set them by hand, KEY=VALUE per line. Stored locally, never sent back to the browser.
                      {p.runtimeEnvKeys && p.runtimeEnvKeys.length > 0 && (
                        <> Currently set: <span className="t-mono">{p.runtimeEnvKeys.join(', ')}</span>. Re-enter all values to replace, or save empty to clear.</>
                      )}
                    </p>
                    <Textarea mono rows={3} value={editEnvText}
                      onChange={(e) => setEditEnvText(e.target.value)}
                      placeholder={'MONGO_URI=mongodb://localhost:27017/app'} />
                    <div className="flex gap-2">
                      <Button size="sm" loading={updateEnv.isPending} onClick={() => void saveEnv(p.id)}>Save env</Button>
                      <Button size="sm" variant="secondary" onClick={() => setEditEnvFor(null)}>Cancel</Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="Recent assessments" />
        {recent.isLoading && <CardBody><SkeletonRows rows={2} /></CardBody>}
        {!recent.isLoading && recents.length === 0 && (
          <EmptyState
            icon={<Clock size={36} strokeWidth={1.5} />}
            title="No assessments yet"
            body="Run an assessment on a project and it will appear here with a live phase timeline."
          />
        )}
        {recents.length > 0 && (
          <div className="divide-y divide-line">
            {recents.slice(0, 12).map((a) => (
              <Link key={a._id} to={`/assessments/${a._id}`}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2">
                <AssessChip state={a.state} />
                <span className="t-small min-w-0 flex-1 truncate text-ink-muted">
                  {a.endpoints.length} endpoint(s), {a.security.findings.length} finding(s)
                </span>
                <span className="t-small text-ink-subtle">{new Date(a.startedAt).toLocaleString()}</span>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
