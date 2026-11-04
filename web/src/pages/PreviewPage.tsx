import { useEffect, useMemo, useState } from 'react';
import type { ProjectFile, ProjectFileResponse } from '../../../src/web/contracts';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { NoProjectState, ProblemAlert, ProjectPicker } from '../components/StatePanels';
import { fileLanguage, fileTone, formatBytes } from '../format';
import { errorDetails, useWorkspace } from '../workspace';

interface FileEntryNode {
  kind: 'file';
  file: ProjectFile;
}

interface DirectoryNode {
  kind: 'directory';
  name: string;
  path: string;
  children: TreeNode[];
  fileCount: number;
}

type TreeNode = FileEntryNode | DirectoryNode;

export function PreviewPage() {
  const { projects, selectedProject } = useWorkspace();
  const projectPath = selectedProject?.rootDir ?? null;

  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [problem, setProblem] = useState<{ message: string; suggestions: string[] } | null>(null);
  const [search, setSearch] = useState('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileData, setFileData] = useState<ProjectFileResponse | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (projectPath === null) {
      setFiles([]);
      setTruncated(false);
      setSelectedFile(null);
      setFileData(null);
      setProblem(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setProblem(null);
    setSelectedFile(null);
    setFileData(null);
    setSearch('');
    setCollapsed(new Set());

    void (async () => {
      try {
        const response = await api.projectFiles(projectPath);
        if (cancelled) return;
        setFiles(response.files);
        setTruncated(response.truncated);
        const preferred =
          response.files.find((file) => file.path === 'README.md') ??
          response.files.find((file) => file.path.endsWith('/README.md')) ??
          response.files[0];
        setSelectedFile(preferred?.path ?? null);
      } catch (caught) {
        if (!cancelled) setProblem(errorDetails(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectPath, reloadToken]);

  useEffect(() => {
    if (projectPath === null || selectedFile === null) {
      setFileData(null);
      setFileLoading(false);
      setFileProblem(null);
      return;
    }

    let cancelled = false;
    setFileLoading(true);
    setFileProblem(null);
    setFileData(null);
    setCopied(false);

    void (async () => {
      try {
        const response = await api.file(projectPath, selectedFile);
        if (!cancelled) setFileData(response);
      } catch (caught) {
        if (!cancelled) setFileProblem(errorDetails(caught).message);
      } finally {
        if (!cancelled) setFileLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectPath, selectedFile]);

  const filteredFiles = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query === '') return files;
    return files.filter((file) => file.path.toLowerCase().includes(query));
  }, [files, search]);

  const tree = useMemo(() => buildFileTree(filteredFiles), [filteredFiles]);

  const totalSize = useMemo(
    () => filteredFiles.reduce((total, file) => total + file.size, 0),
    [filteredFiles],
  );

  const lines = useMemo(() => (fileData === null ? [] : fileData.content.split('\n')), [fileData]);
  const waitingForFile =
    fileLoading || (selectedFile !== null && fileData === null && fileProblem === null);

  const copyContents = async (): Promise<void> => {
    if (fileData === null || fileData.binary) return;
    try {
      await navigator.clipboard.writeText(fileData.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const toggleFolder = (folderPath: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  };

  return (
    <div className="page preview-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">
            <Icon name="eye" size={15} />
            Generated output, no mystery
          </span>
          <h1>Preview generated files</h1>
          <p>
            Browse the files the engine wrote to disk. Source, configuration, migrations, routes,
            and docs are all visible exactly as they were generated.
          </p>
        </div>
        <div className="heading-note">
          <Icon name="folder" size={18} />
          <span>Read directly from the project</span>
        </div>
      </div>

      {projects.length === 0 ? (
        <NoProjectState />
      ) : (
        <>
          <ProjectPicker hint="Choose a generated project to inspect." />

          {problem !== null && (
            <ProblemAlert
              message={problem.message}
              suggestions={problem.suggestions}
              onDismiss={() => setProblem(null)}
            />
          )}

          {selectedProject !== null && (
            <div className="file-browser">
              <aside className="file-sidebar card">
                <div className="file-sidebar-heading">
                  <div>
                    <span className="section-kicker">Project files</span>
                    <h2>
                      {selectedProject.name}
                      <span className="count-badge">{files.length}</span>
                    </h2>
                  </div>
                  <button
                    aria-label="Refresh files"
                    className="icon-button"
                    onClick={() => setReloadToken((token) => token + 1)}
                    title="Refresh files"
                    type="button"
                  >
                    <Icon name="refresh" size={17} />
                  </button>
                </div>

                <label className="file-search">
                  <Icon name="search" size={16} />
                  <input
                    aria-label="Search generated files"
                    autoComplete="off"
                    placeholder="Search files..."
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                  {search !== '' && (
                    <button
                      aria-label="Clear search"
                      className="search-clear"
                      onClick={() => setSearch('')}
                      type="button"
                    >
                      ×
                    </button>
                  )}
                </label>

                <div className="file-summary">
                  <span>
                    {filteredFiles.length} file{filteredFiles.length === 1 ? '' : 's'}
                  </span>
                  <span>{formatBytes(totalSize)}</span>
                </div>

                <div className="file-tree">
                  {loading ? (
                    <FileTreeSkeleton />
                  ) : filteredFiles.length === 0 ? (
                    <div className="file-empty">
                      <Icon name="search" size={22} />
                      <p>
                        {files.length === 0
                          ? 'This project has no readable files yet.'
                          : 'No generated file matches your search.'}
                      </p>
                    </div>
                  ) : (
                    <FileTreeView
                      collapsed={collapsed}
                      depth={0}
                      node={tree}
                      onSelect={setSelectedFile}
                      onToggle={toggleFolder}
                      searchActive={search.trim() !== ''}
                      selectedFile={selectedFile}
                    />
                  )}
                  {truncated && (
                    <p className="file-truncated">
                      <Icon name="warning" size={14} />
                      Listing stopped at 5,000 files.
                    </p>
                  )}
                </div>
              </aside>

              <section className="card file-viewer">
                {selectedFile === null ? (
                  <div className="viewer-empty">
                    <span className="empty-icon">
                      <Icon name="file" size={26} />
                    </span>
                    <h3>Select a file</h3>
                    <p>Pick any file from the tree to see its generated contents.</p>
                  </div>
                ) : (
                  <>
                    <div className="viewer-header">
                      <div className="viewer-title">
                        <span className={`file-type-dot ${fileTone(extensionOf(selectedFile))}`} />
                        <div>
                          <strong>{selectedFile.split('/').at(-1)}</strong>
                          <code>{selectedFile}</code>
                        </div>
                      </div>
                      <div className="viewer-actions">
                        {fileData !== null && (
                          <>
                            <span className="language-pill">
                              {fileLanguage(fileData.file.extension)}
                            </span>
                            <span className="viewer-size">{formatBytes(fileData.file.size)}</span>
                            <button
                              className="button button-small button-ghost"
                              disabled={fileData.binary}
                              onClick={() => void copyContents()}
                              type="button"
                            >
                              <Icon name={copied ? 'check' : 'copy'} size={15} />
                              {copied ? 'Copied' : 'Copy'}
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {fileProblem !== null && <ProblemAlert message={fileProblem} />}

                    {waitingForFile ? (
                      <div className="viewer-loading">
                        <span className="spinner" />
                        Reading file...
                      </div>
                    ) : fileData === null ? (
                      <div className="viewer-empty">
                        <p>The file could not be loaded.</p>
                      </div>
                    ) : fileData.binary ? (
                      <div className="viewer-empty">
                        <span className="empty-icon">
                          <Icon name="file" size={26} />
                        </span>
                        <h3>Binary file</h3>
                        <p>This file contains binary data and cannot be shown as text.</p>
                      </div>
                    ) : (
                      <>
                        {fileData.truncated && (
                          <p className="viewer-notice">
                            <Icon name="warning" size={15} />
                            Showing the first 512 KB of this file.
                          </p>
                        )}
                        <div className="code-view" tabIndex={0}>
                          <pre className="code-block">
                            <code>
                              {lines.map((line, index) => (
                                <span className="code-line" key={index}>
                                  <span className="line-number">{index + 1}</span>
                                  <span className="line-text">{line === '' ? ' ' : line}</span>
                                </span>
                              ))}
                            </code>
                          </pre>
                        </div>
                      </>
                    )}
                  </>
                )}
              </section>
            </div>
          )}
        </>
      )}

      <div className="page-footnote">
        <span className="footnote-icon">
          <Icon name="warning" size={16} />
        </span>
        <span>
          The preview is read-only. Dependencies, build output, and version-control folders such as{' '}
          <code>node_modules</code>, <code>target</code>, and <code>.git</code> are hidden.
        </span>
      </div>
    </div>
  );
}

function extensionOf(filePath: string): string {
  const name = filePath.split('/').at(-1) ?? filePath;
  const separator = name.lastIndexOf('.');
  return separator === -1 ? '' : name.slice(separator + 1).toLowerCase();
}

function FileTreeSkeleton() {
  return (
    <div className="file-skeleton" aria-hidden="true">
      {Array.from({ length: 7 }, (_, index) => (
        <span key={index} style={{ width: `${58 + ((index * 13) % 34)}%` }} />
      ))}
    </div>
  );
}

function buildFileTree(files: ProjectFile[]): DirectoryNode {
  const root: DirectoryNode = {
    kind: 'directory',
    name: '',
    path: '',
    children: [],
    fileCount: 0,
  };
  const directories = new Map<string, DirectoryNode>([['', root]]);

  for (const file of files) {
    const segments = file.path.split('/').filter((segment) => segment !== '');
    segments.pop();

    let parent = root;
    let directoryPath = '';
    for (const segment of segments) {
      directoryPath = directoryPath === '' ? segment : `${directoryPath}/${segment}`;
      let directory = directories.get(directoryPath);
      if (directory === undefined) {
        directory = {
          kind: 'directory',
          name: segment,
          path: directoryPath,
          children: [],
          fileCount: 0,
        };
        directories.set(directoryPath, directory);
        parent.children.push(directory);
      }
      parent = directory;
    }

    parent.children.push({ kind: 'file', file });
  }

  countTreeFiles(root);
  sortTree(root);
  return root;
}

function countTreeFiles(node: DirectoryNode): number {
  let count = 0;
  for (const child of node.children) {
    count += child.kind === 'file' ? 1 : countTreeFiles(child);
  }
  node.fileCount = count;
  return count;
}

function sortTree(node: DirectoryNode): void {
  node.children.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
    const leftName = left.kind === 'file' ? fileNameOf(left.file.path) : left.name;
    const rightName = right.kind === 'file' ? fileNameOf(right.file.path) : right.name;
    return leftName.localeCompare(rightName);
  });
  for (const child of node.children) {
    if (child.kind === 'directory') sortTree(child);
  }
}

function fileNameOf(filePath: string): string {
  return filePath.split('/').at(-1) ?? filePath;
}

interface FileTreeViewProps {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  searchActive: boolean;
  selectedFile: string | null;
  onSelect: (filePath: string) => void;
  onToggle: (folderPath: string) => void;
}

function FileTreeView({
  node,
  depth,
  collapsed,
  searchActive,
  selectedFile,
  onSelect,
  onToggle,
}: FileTreeViewProps) {
  if (node.kind === 'file') {
    return (
      <button
        className={selectedFile === node.file.path ? 'file-row active' : 'file-row'}
        onClick={() => onSelect(node.file.path)}
        style={{ paddingLeft: 8 + depth * 14 }}
        title={node.file.path}
        type="button"
      >
        <span className={`file-type-dot ${fileTone(node.file.extension)}`} />
        <span className="file-row-name">{fileNameOf(node.file.path)}</span>
        <span className="file-row-size">{formatBytes(node.file.size)}</span>
      </button>
    );
  }

  const isRoot = node.path === '';
  const expanded = isRoot || searchActive || !collapsed.has(node.path);

  return (
    <div className={isRoot ? 'file-tree-root' : 'tree-children'}>
      {!isRoot && (
        <button
          aria-expanded={expanded}
          className="tree-folder"
          onClick={() => onToggle(node.path)}
          style={{ paddingLeft: 8 + depth * 14 }}
          title={node.path}
          type="button"
        >
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={13} />
          <Icon className="tree-folder-icon" name="folder" size={14} />
          <span className="tree-folder-name">{node.name}</span>
          <span className="tree-folder-count">{node.fileCount}</span>
        </button>
      )}
      {expanded &&
        node.children.map((child) => (
          <FileTreeView
            collapsed={collapsed}
            depth={isRoot ? depth : depth + 1}
            key={child.kind === 'file' ? `file:${child.file.path}` : `dir:${child.path}`}
            node={child}
            onSelect={onSelect}
            onToggle={onToggle}
            searchActive={searchActive}
            selectedFile={selectedFile}
          />
        ))}
    </div>
  );
}
