import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { EntityConfig } from '../../../src/core/config';
import type {
  CommandResult,
  EntityPreviewFile,
  EntityPreviewResponse,
  SaveEntityYamlResponse,
} from '../../../src/web/contracts';
import { api, ApiError } from '../api';
import { CommandConsole } from '../components/CommandConsole';
import { Icon } from '../components/Icon';
import { NoProjectState, ProblemAlert, ProjectPicker } from '../components/StatePanels';
import {
  applicableValidations,
  blankField,
  blankRelation,
  draftFromEntity,
  emptyDraft,
  isNumericFieldType,
  isStringFieldType,
  RELATION_TYPES,
  relationOwnsColumn,
  relationShowsInverse,
  toEntityDefinition,
  validateDraft,
  validationOptionsForType,
  type EntityDraft,
  type FieldRow,
  type FieldType,
  type RelationRow,
  type RelationType,
} from '../entity-editor';
import { titleCase } from '../format';
import { errorDetails, useWorkspace } from '../workspace';

const FALLBACK_FIELD_TYPES: FieldType[] = [
  'String',
  'int',
  'Integer',
  'long',
  'BigDecimal',
  'boolean',
  'UUID',
  'LocalDate',
  'LocalDateTime',
  'Instant',
];

const FALLBACK_VALIDATIONS = [
  'NotBlank',
  'Email',
  'Positive',
  'PositiveOrZero',
  'Negative',
  'NegativeOrZero',
  'Past',
  'PastOrPresent',
  'Future',
  'FutureOrPresent',
];

interface Problem {
  message: string;
  suggestions: string[];
}

type PreviewTab = 'yaml' | 'files';

export function EntitiesPage() {
  const { projects, meta, selectedProject, refresh } = useWorkspace();
  const [draft, setDraft] = useState<EntityDraft>(emptyDraft);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [savingYaml, setSavingYaml] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const [result, setResult] = useState<CommandResult | null>(null);
  const [yamlNotice, setYamlNotice] = useState<SaveEntityYamlResponse | null>(null);
  const [yamlConflict, setYamlConflict] = useState(false);
  const [preview, setPreview] = useState<EntityPreviewResponse | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewTab, setPreviewTab] = useState<PreviewTab>('yaml');
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const previewSequence = useRef(0);

  const projectRoot = selectedProject?.rootDir ?? null;

  useEffect(() => {
    setDraft(emptyDraft());
    setEditingName(null);
    setResult(null);
    setYamlNotice(null);
    setYamlConflict(false);
    setProblem(null);
    setValidation(null);
    setPreview(null);
    setPreviewError(null);
    setPreviewBusy(false);
  }, [projectRoot]);

  const fieldTypes = useMemo(
    () => (meta?.fieldTypes ?? FALLBACK_FIELD_TYPES) as FieldType[],
    [meta],
  );
  const availableValidations = meta?.validations ?? FALLBACK_VALIDATIONS;

  const targetOptions = useMemo(() => {
    const currentName = draft.name.trim().toLowerCase();
    return (selectedProject?.entities ?? [])
      .filter((entity) => entity.name.toLowerCase() !== currentName)
      .map((entity) => entity.name);
  }, [draft.name, selectedProject]);

  const previewFile =
    preview?.files.find((file) => file.path === previewPath) ?? preview?.files[0] ?? null;

  useEffect(() => {
    if (selectedProject === null) {
      setPreview(null);
      setPreviewBusy(false);
      setPreviewError(null);
      return;
    }

    const localProblem = validateDraft(draft);
    if (localProblem !== null) {
      previewSequence.current += 1;
      setPreview(null);
      setPreviewBusy(false);
      setPreviewError(null);
      return;
    }

    const sequence = previewSequence.current + 1;
    previewSequence.current = sequence;
    const timer = window.setTimeout(() => {
      setPreviewBusy(true);
      void api
        .previewEntity({
          ...toEntityDefinition(draft),
          projectPath: selectedProject.rootDir,
        })
        .then((response) => {
          if (previewSequence.current !== sequence) return;
          setPreview(response);
          setPreviewError(null);
          setPreviewPath((current) =>
            response.files.some((file) => file.path === current)
              ? current
              : (response.files[0]?.path ?? null),
          );
        })
        .catch((caught) => {
          if (previewSequence.current !== sequence) return;
          setPreview(null);
          setPreviewError(errorDetails(caught).message);
        })
        .finally(() => {
          if (previewSequence.current === sequence) setPreviewBusy(false);
        });
    }, 450);

    return () => window.clearTimeout(timer);
  }, [draft, selectedProject]);

  const changeField = (key: string, update: (field: FieldRow) => FieldRow): void => {
    setDraft((current) => ({
      ...current,
      fields: current.fields.map((field) => (field.key === key ? update(field) : field)),
    }));
    setValidation(null);
    setYamlConflict(false);
  };

  const patchField = (key: string, patch: Partial<FieldRow>): void => {
    changeField(key, (field) => ({ ...field, ...patch }));
  };

  const changeFieldType = (key: string, type: FieldType): void => {
    changeField(key, (field) => ({
      ...field,
      type,
      validations: applicableValidations(type, field.validations, availableValidations),
      minLength: isStringFieldType(type) ? field.minLength : '',
      maxLength: isStringFieldType(type) ? field.maxLength : '',
      pattern: isStringFieldType(type) ? field.pattern : '',
      min: isNumericFieldType(type) ? field.min : '',
      max: isNumericFieldType(type) ? field.max : '',
    }));
  };

  const toggleValidation = (key: string, validationName: string): void => {
    changeField(key, (field) => ({
      ...field,
      validations: field.validations.includes(validationName)
        ? field.validations.filter((item) => item !== validationName)
        : [...field.validations, validationName],
    }));
  };

  const addField = (): void => {
    setDraft((current) => ({ ...current, fields: [...current.fields, blankField()] }));
  };

  const removeField = (key: string): void => {
    setDraft((current) => {
      if (current.fields.length === 1) return current;
      return { ...current, fields: current.fields.filter((field) => field.key !== key) };
    });
  };

  const changeRelation = (key: string, update: (relation: RelationRow) => RelationRow): void => {
    setDraft((current) => ({
      ...current,
      relations: current.relations.map((relation) =>
        relation.key === key ? update(relation) : relation,
      ),
    }));
    setValidation(null);
    setYamlConflict(false);
  };

  const patchRelation = (key: string, patch: Partial<RelationRow>): void => {
    changeRelation(key, (relation) => ({ ...relation, ...patch }));
  };

  const changeRelationType = (key: string, type: RelationType): void => {
    changeRelation(key, (relation) => {
      const next: RelationRow = { ...relation, type };
      if (!relationShowsInverse(next)) next.inverse = false;
      if (!relationOwnsColumn(next)) next.required = false;
      if (type === 'many-to-one') {
        next.inverse = false;
        next.mappedBy = '';
      }
      return next;
    });
  };

  const addRelation = (): void => {
    setDraft((current) => ({
      ...current,
      relations: [...current.relations, blankRelation()],
    }));
  };

  const removeRelation = (key: string): void => {
    setDraft((current) => ({
      ...current,
      relations: current.relations.filter((relation) => relation.key !== key),
    }));
  };

  const selectEntity = (entity: EntityConfig): void => {
    setDraft(draftFromEntity(entity));
    setEditingName(entity.name);
    setResult(null);
    setYamlNotice(null);
    setYamlConflict(false);
    setProblem(null);
    setValidation(null);
    setPreview(null);
    setPreviewError(null);
  };

  const startNewEntity = (): void => {
    setDraft(emptyDraft());
    setEditingName(null);
    setResult(null);
    setYamlNotice(null);
    setYamlConflict(false);
    setProblem(null);
    setValidation(null);
    setPreview(null);
    setPreviewError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (selectedProject === null) return;

    const localProblem = validateDraft(draft);
    if (localProblem !== null) {
      setValidation(localProblem);
      return;
    }

    const definition = toEntityDefinition(draft);
    setSubmitting(true);
    setProblem(null);
    setResult(null);
    setYamlNotice(null);
    setYamlConflict(false);
    try {
      const response = await api.createEntity({
        ...definition,
        projectPath: selectedProject.rootDir,
      });
      setResult(response);
      await refresh(selectedProject.rootDir);
      if (editingName === null) {
        setDraft(emptyDraft());
      }
      setValidation(null);
    } catch (caught) {
      setProblem(errorDetails(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const saveYaml = async (overwrite = false): Promise<void> => {
    const localProblem = validateDraft(draft);
    if (localProblem !== null) {
      setValidation(localProblem);
      return;
    }

    setSavingYaml(true);
    setProblem(null);
    setYamlNotice(null);
    setYamlConflict(false);
    try {
      const response = await api.saveEntityYaml({
        ...toEntityDefinition(draft),
        overwrite,
      });
      setYamlNotice(response);
      setValidation(null);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        setYamlConflict(true);
      } else {
        setProblem(errorDetails(caught));
      }
    } finally {
      setSavingYaml(false);
    }
  };

  const copyPreview = async (): Promise<void> => {
    const contents = previewTab === 'yaml' ? preview?.yaml : previewFile?.contents;
    if (contents === undefined) return;
    try {
      await navigator.clipboard.writeText(contents);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; the preview remains selectable.
    }
  };

  return (
    <div className="page entities-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">
            <Icon name="database" size={15} />
            Entities, generated everywhere
          </span>
          <h1>Visual entity editor</h1>
          <p>
            Model fields, validations, and relations once. The shared engine generates the JPA
            entity, migration, API, DTOs, Angular page, and routes.
          </p>
        </div>
        <div className="heading-note">
          <Icon name="terminal" size={18} />
          <span>
            Calls <code>runEntityCommand</code>
          </span>
        </div>
      </div>

      {projects.length === 0 ? (
        <NoProjectState />
      ) : (
        <>
          <ProjectPicker hint="Entities are generated into this project." />

          {problem !== null && (
            <ProblemAlert
              message={problem.message}
              suggestions={problem.suggestions}
              onDismiss={() => setProblem(null)}
            />
          )}

          {result !== null && result.project !== undefined && (
            <div className="success-banner">
              <span className="success-icon">
                <Icon name="check" size={21} />
              </span>
              <div>
                <strong>{result.project.name} is up to date.</strong>
                <p>
                  The entity is recorded in <code>.cleanstack/project.json</code> and generated
                  across the stack.
                </p>
              </div>
              <div className="success-actions">
                <a className="button button-small button-secondary" href="#/preview">
                  <Icon name="eye" size={15} />
                  Preview files
                </a>
              </div>
            </div>
          )}

          {yamlNotice !== null && (
            <div className="success-banner success-banner-compact">
              <span className="success-icon">
                <Icon name="save" size={20} />
              </span>
              <div>
                <strong>Saved {yamlNotice.path}</strong>
                <p>
                  {yamlNotice.overwritten
                    ? 'The existing descriptor was replaced with this draft.'
                    : 'The descriptor is ready to seed new projects or CLI regeneration.'}
                </p>
              </div>
            </div>
          )}

          <div className="entity-layout">
            <form className="card form-card entity-form" onSubmit={(event) => void submit(event)}>
              <div className="card-heading">
                <div>
                  <span className="section-kicker">
                    {editingName === null ? 'New entity' : 'Editing entity'}
                  </span>
                  <h2>{editingName === null ? 'Model the domain' : `Refine ${editingName}`}</h2>
                </div>
                {editingName === null ? (
                  <span className="form-step">
                    {draft.fields.length} field{draft.fields.length === 1 ? '' : 's'}
                  </span>
                ) : (
                  <button
                    className="button button-small button-secondary"
                    onClick={startNewEntity}
                    type="button"
                  >
                    <Icon name="plus" size={15} />
                    New entity
                  </button>
                )}
              </div>

              <div className="form-grid">
                <label className="field">
                  <span className="field-label">Entity name</span>
                  <input
                    autoComplete="off"
                    disabled={editingName !== null}
                    placeholder="Product"
                    value={draft.name}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, name: event.target.value }));
                      setValidation(null);
                      setYamlConflict(false);
                    }}
                  />
                  <span className="field-hint">
                    {editingName === null
                      ? 'Use a singular PascalCase name.'
                      : 'Rename is disabled while editing an existing entity.'}
                  </span>
                </label>

                <label className="field">
                  <span className="field-label">Table name</span>
                  <input
                    autoComplete="off"
                    placeholder={`${titleCase(draft.name.trim() || 'products')} table (optional)`}
                    value={draft.tableName}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, tableName: event.target.value }));
                      setValidation(null);
                      setYamlConflict(false);
                    }}
                  />
                  <span className="field-hint">Leave empty to derive it automatically.</span>
                </label>
              </div>

              <div className="field-builder">
                <div className="field-builder-heading">
                  <div>
                    <span className="field-label">Fields</span>
                    <span className="field-hint">
                      Types, constraints, and Bean Validation annotations.
                    </span>
                  </div>
                  <button
                    className="button button-small button-secondary"
                    onClick={addField}
                    type="button"
                  >
                    <Icon name="plus" size={15} />
                    Add field
                  </button>
                </div>

                <div className="editor-fields">
                  {draft.fields.map((field, index) => (
                    <FieldEditor
                      key={field.key}
                      canRemove={draft.fields.length > 1}
                      field={field}
                      fieldTypes={fieldTypes}
                      index={index}
                      validations={availableValidations}
                      onChange={(patch) => patchField(field.key, patch)}
                      onRemove={() => removeField(field.key)}
                      onToggleValidation={(validationName) =>
                        toggleValidation(field.key, validationName)
                      }
                      onTypeChange={(type) => changeFieldType(field.key, type)}
                    />
                  ))}
                </div>
              </div>

              <div className="field-builder relation-builder">
                <div className="field-builder-heading">
                  <div>
                    <span className="field-label">Relations</span>
                    <span className="field-hint">
                      Reference other entities in this project. The engine resolves owning sides,
                      joins, and DTO fields.
                    </span>
                  </div>
                  <button
                    className="button button-small button-secondary"
                    onClick={addRelation}
                    type="button"
                  >
                    <Icon name="link" size={15} />
                    Add relation
                  </button>
                </div>

                {draft.relations.length === 0 ? (
                  <p className="editor-empty">
                    No relations yet. Add one to connect this entity to another.
                  </p>
                ) : (
                  <div className="editor-relations">
                    {draft.relations.map((relation, index) => (
                      <RelationEditor
                        key={relation.key}
                        index={index}
                        relation={relation}
                        targets={targetOptions}
                        onChange={(patch) => patchRelation(relation.key, patch)}
                        onRemove={() => removeRelation(relation.key)}
                        onTypeChange={(type) => changeRelationType(relation.key, type)}
                      />
                    ))}
                  </div>
                )}

                <datalist id="entity-target-options">
                  {targetOptions.map((target) => (
                    <option key={target} value={target} />
                  ))}
                </datalist>
              </div>

              {validation !== null && <p className="field-error">{validation}</p>}

              {yamlConflict && (
                <div className="inline-confirm" role="alert">
                  <div>
                    <strong>entities/{draft.name.trim()}.yaml already exists.</strong>
                    <span>Replace the existing descriptor with this draft?</span>
                  </div>
                  <div className="inline-confirm-actions">
                    <button
                      className="button button-small button-secondary"
                      onClick={() => setYamlConflict(false)}
                      type="button"
                    >
                      Cancel
                    </button>
                    <button
                      className="button button-small button-primary"
                      disabled={savingYaml}
                      onClick={() => void saveYaml(true)}
                      type="button"
                    >
                      <Icon name="save" size={14} />
                      Overwrite YAML
                    </button>
                  </div>
                </div>
              )}

              <div className="form-actions">
                <span className="form-footnote">
                  <Icon name="layers" size={15} />
                  YAML saves to <code>entities/</code> in the studio workspace.
                </span>
                <div className="entity-action-buttons">
                  <button
                    className="button button-secondary"
                    disabled={submitting || savingYaml}
                    onClick={() => void saveYaml()}
                    type="button"
                  >
                    {savingYaml ? (
                      <>
                        <span className="spinner" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Icon name="save" size={16} />
                        Save as YAML
                      </>
                    )}
                  </button>
                  <button
                    className="button button-primary"
                    disabled={submitting || savingYaml}
                    type="submit"
                  >
                    {submitting ? (
                      <>
                        <span className="spinner" />
                        Generating...
                      </>
                    ) : (
                      <>
                        <Icon name="database" size={17} />
                        {editingName === null ? 'Generate entity' : 'Regenerate entity'}
                      </>
                    )}
                  </button>
                </div>
              </div>
            </form>

            <aside className="entity-aside">
              <div className="card entity-preview">
                <div className="card-heading">
                  <div>
                    <span className="section-kicker">Live preview</span>
                    <h2>What the engine will write</h2>
                  </div>
                  <span className={`preview-status${previewError !== null ? ' is-error' : ''}`}>
                    {previewBusy ? <span className="spinner" /> : <span className="status-dot" />}
                    {previewBusy ? 'Rendering' : previewError !== null ? 'Unavailable' : 'Live'}
                  </span>
                </div>

                <div className="preview-toolbar">
                  <div className="preview-tabs" role="tablist" aria-label="Preview content">
                    <button
                      aria-selected={previewTab === 'yaml'}
                      className={`preview-tab${previewTab === 'yaml' ? ' is-active' : ''}`}
                      onClick={() => setPreviewTab('yaml')}
                      role="tab"
                      type="button"
                    >
                      YAML
                    </button>
                    <button
                      aria-selected={previewTab === 'files'}
                      className={`preview-tab${previewTab === 'files' ? ' is-active' : ''}`}
                      onClick={() => setPreviewTab('files')}
                      role="tab"
                      type="button"
                    >
                      Generated files
                      {preview !== null && <span>{preview.files.length}</span>}
                    </button>
                  </div>
                  <button
                    aria-label="Copy preview contents"
                    className="icon-button preview-copy"
                    disabled={preview === null}
                    onClick={() => void copyPreview()}
                    title={copied ? 'Copied' : 'Copy preview contents'}
                    type="button"
                  >
                    <Icon name={copied ? 'check' : 'copy'} size={14} />
                  </button>
                </div>

                <div className="preview-body">
                  {previewError !== null ? (
                    <p className="preview-note">
                      <Icon name="warning" size={15} />
                      {previewError}
                    </p>
                  ) : preview === null ? (
                    <p className="preview-note">
                      {previewBusy
                        ? 'Rendering the entity through the shared templates...'
                        : 'Complete the draft to see YAML and representative generated files.'}
                    </p>
                  ) : previewTab === 'yaml' ? (
                    <pre className="code-preview" aria-label="Entity YAML preview">
                      {preview.yaml}
                    </pre>
                  ) : preview.files.length === 0 ? (
                    <p className="preview-note">
                      No generated files are available for this project.
                    </p>
                  ) : (
                    <>
                      <div className="preview-file-list" role="tablist" aria-label="Preview files">
                        {preview.files.map((file) => (
                          <button
                            aria-selected={previewFile?.path === file.path}
                            className={`preview-file-chip${
                              previewFile?.path === file.path ? ' is-active' : ''
                            }`}
                            key={file.path}
                            onClick={() => setPreviewPath(file.path)}
                            role="tab"
                            type="button"
                          >
                            <span className={`preview-side ${file.side}`}>{file.side}</span>
                            {previewFileLabel(file)}
                          </button>
                        ))}
                      </div>
                      {previewFile !== null && (
                        <>
                          <div className="preview-file-path">
                            <code>{previewFile.path}</code>
                            <span>{previewFile.language}</span>
                          </div>
                          <pre className="code-preview" aria-label={`${previewFile.path} preview`}>
                            {previewFile.contents}
                          </pre>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div className="card entity-catalog">
                <div className="card-heading">
                  <div>
                    <span className="section-kicker">In this project</span>
                    <h2>Entity catalog</h2>
                  </div>
                  <span className="count-badge">{selectedProject?.entities.length ?? 0}</span>
                </div>

                {selectedProject === null || selectedProject.entities.length === 0 ? (
                  <p className="muted">
                    No entities yet. The first one you generate will appear here with its fields.
                  </p>
                ) : (
                  <div className="entity-catalog-list">
                    {selectedProject.entities.map((entity) => (
                      <article
                        className={`entity-card${editingName === entity.name ? ' is-active' : ''}`}
                        key={entity.name}
                      >
                        <div className="entity-card-heading">
                          <span className="entity-avatar">{entity.name.slice(0, 2)}</span>
                          <div>
                            <strong>{entity.name}</strong>
                            <span>{entity.tableName ?? `${titleCase(entity.name)} table`}</span>
                          </div>
                          <span className="entity-field-count">
                            {entity.fields.length} field{entity.fields.length === 1 ? '' : 's'}
                          </span>
                          <button
                            aria-label={`Edit ${entity.name}`}
                            className="icon-button entity-edit"
                            onClick={() => selectEntity(entity)}
                            title={`Edit ${entity.name}`}
                            type="button"
                          >
                            <Icon name="pencil" size={14} />
                          </button>
                        </div>
                        {entity.fields.length > 0 && (
                          <div className="entity-fields">
                            {entity.fields.map((field) => (
                              <span className="entity-field" key={field.name}>
                                <span>{field.name}</span>
                                <code>{field.type}</code>
                                {field.required && <em>required</em>}
                              </span>
                            ))}
                          </div>
                        )}
                        {entity.relations.length > 0 && (
                          <div className="entity-relations">
                            {entity.relations.map((relation) => (
                              <span key={relation.field}>
                                {relation.field} → {relation.target}
                              </span>
                            ))}
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                )}
              </div>

              <div className="info-card">
                <Icon name="sparkles" size={19} />
                <div>
                  <strong>One entity, every layer</strong>
                  <p>
                    Preview and generation use the manifests in <code>templates/</code>. The studio
                    never renders code itself.
                  </p>
                </div>
              </div>
            </aside>
          </div>

          {result !== null && (
            <CommandConsole
              title="Entity engine output"
              command={result.command}
              messages={result.messages}
            />
          )}
        </>
      )}

      <div className="page-footnote">
        <span className="footnote-icon">
          <Icon name="warning" size={16} />
        </span>
        <span>
          Regenerating an existing entity preserves protected regions. <strong>Save as YAML</strong>{' '}
          writes a descriptor to the workspace <code>entities/</code> directory; overwrite it only
          when you intend to replace that file.
        </span>
      </div>
    </div>
  );
}

interface FieldEditorProps {
  field: FieldRow;
  index: number;
  fieldTypes: readonly FieldType[];
  validations: readonly string[];
  canRemove: boolean;
  onChange(patch: Partial<FieldRow>): void;
  onTypeChange(type: FieldType): void;
  onToggleValidation(validation: string): void;
  onRemove(): void;
}

function FieldEditor({
  field,
  index,
  fieldTypes,
  validations,
  canRemove,
  onChange,
  onTypeChange,
  onToggleValidation,
  onRemove,
}: FieldEditorProps) {
  const stringField = isStringFieldType(field.type);
  const numericField = isNumericFieldType(field.type);
  const validationChoices = validationOptionsForType(field.type, validations);

  return (
    <article className="editor-field">
      <div className="editor-field-head">
        <span className="editor-index">{index + 1}</span>
        <label className="field">
          <span className="field-label">Name</span>
          <input
            aria-label={`Field ${index + 1} name`}
            autoComplete="off"
            placeholder={index === 0 ? 'name' : 'fieldName'}
            value={field.name}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </label>
        <label className="field">
          <span className="field-label">Type</span>
          <select
            aria-label={`Field ${index + 1} type`}
            value={field.type}
            onChange={(event) => onTypeChange(event.target.value as FieldType)}
          >
            {fieldTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <button
          aria-label={`Remove field ${index + 1}`}
          className="icon-button field-remove"
          disabled={!canRemove}
          onClick={onRemove}
          title="Remove field"
          type="button"
        >
          <Icon name="trash" size={16} />
        </button>
      </div>

      <div className="editor-options">
        <label className="toggle-chip">
          <input
            checked={field.required}
            type="checkbox"
            onChange={(event) => onChange({ required: event.target.checked })}
          />
          <span className="toggle-mark" aria-hidden="true" />
          <span>Required</span>
        </label>
        <label className="toggle-chip">
          <input
            checked={field.unique}
            type="checkbox"
            onChange={(event) => onChange({ unique: event.target.checked })}
          />
          <span className="toggle-mark" aria-hidden="true" />
          <span>Unique</span>
        </label>
        <label className="toggle-chip">
          <input
            checked={field.generated}
            type="checkbox"
            onChange={(event) => onChange({ generated: event.target.checked })}
          />
          <span className="toggle-mark" aria-hidden="true" />
          <span>Generated</span>
        </label>
      </div>

      {(stringField || numericField) && (
        <div className={`editor-constraint-grid${stringField ? ' has-pattern' : ''}`}>
          {stringField && (
            <>
              <label className="field">
                <span className="field-label">Min length</span>
                <input
                  aria-label={`Field ${index + 1} min length`}
                  inputMode="numeric"
                  placeholder="—"
                  value={field.minLength}
                  onChange={(event) => onChange({ minLength: event.target.value })}
                />
              </label>
              <label className="field">
                <span className="field-label">Max length</span>
                <input
                  aria-label={`Field ${index + 1} max length`}
                  inputMode="numeric"
                  placeholder="—"
                  value={field.maxLength}
                  onChange={(event) => onChange({ maxLength: event.target.value })}
                />
              </label>
              <label className="field">
                <span className="field-label">Pattern</span>
                <input
                  aria-label={`Field ${index + 1} pattern`}
                  autoComplete="off"
                  placeholder="^[A-Z].*"
                  value={field.pattern}
                  onChange={(event) => onChange({ pattern: event.target.value })}
                />
              </label>
            </>
          )}
          {numericField && (
            <>
              <label className="field">
                <span className="field-label">Min</span>
                <input
                  aria-label={`Field ${index + 1} minimum`}
                  inputMode="decimal"
                  placeholder="—"
                  value={field.min}
                  onChange={(event) => onChange({ min: event.target.value })}
                />
              </label>
              <label className="field">
                <span className="field-label">Max</span>
                <input
                  aria-label={`Field ${index + 1} maximum`}
                  inputMode="decimal"
                  placeholder="—"
                  value={field.max}
                  onChange={(event) => onChange({ max: event.target.value })}
                />
              </label>
            </>
          )}
        </div>
      )}

      {validationChoices.length > 0 && (
        <div className="editor-validations">
          <span className="field-label">Validation annotations</span>
          <div className="validation-chips">
            {validationChoices.map((validationName) => {
              const active = field.validations.includes(validationName);
              return (
                <button
                  aria-pressed={active}
                  className={`validation-chip${active ? ' is-active' : ''}`}
                  key={validationName}
                  onClick={() => onToggleValidation(validationName)}
                  type="button"
                >
                  {active && <Icon name="check" size={11} />}
                  {validationName}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </article>
  );
}

interface RelationEditorProps {
  relation: RelationRow;
  index: number;
  targets: readonly string[];
  onChange(patch: Partial<RelationRow>): void;
  onTypeChange(type: RelationType): void;
  onRemove(): void;
}

function RelationEditor({
  relation,
  index,
  targets,
  onChange,
  onTypeChange,
  onRemove,
}: RelationEditorProps) {
  const type = RELATION_TYPES.find((candidate) => candidate.value === relation.type);
  const owning = relationOwnsColumn(relation);
  const canBeRequired =
    relation.type === 'many-to-one' || (relation.type === 'one-to-one' && owning);
  const showInverse = relationShowsInverse(relation);
  const showMappedBy = !owning || relation.mappedBy.trim() !== '' || relation.inverse;

  return (
    <article className="editor-relation">
      <div className="editor-field-head relation-head">
        <span className="editor-index relation-icon">
          <Icon name="link" size={14} />
        </span>
        <label className="field">
          <span className="field-label">Field name</span>
          <input
            aria-label={`Relation ${index + 1} field name`}
            autoComplete="off"
            placeholder="category"
            value={relation.field}
            onChange={(event) => onChange({ field: event.target.value })}
          />
        </label>
        <label className="field">
          <span className="field-label">Type</span>
          <select
            aria-label={`Relation ${index + 1} type`}
            value={relation.type}
            onChange={(event) => onTypeChange(event.target.value as RelationType)}
          >
            {RELATION_TYPES.map((candidate) => (
              <option key={candidate.value} value={candidate.value}>
                {candidate.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Target entity</span>
          <input
            aria-label={`Relation ${index + 1} target`}
            autoComplete="off"
            list="entity-target-options"
            placeholder={targets[0] ?? 'Category'}
            value={relation.target}
            onChange={(event) => onChange({ target: event.target.value })}
          />
        </label>
        <button
          aria-label={`Remove relation ${index + 1}`}
          className="icon-button field-remove"
          onClick={onRemove}
          title="Remove relation"
          type="button"
        >
          <Icon name="trash" size={16} />
        </button>
      </div>

      <div className="relation-body">
        <p className="relation-hint">{type?.hint}</p>
        <div className="editor-options">
          {canBeRequired && (
            <label className="toggle-chip">
              <input
                checked={relation.required}
                type="checkbox"
                onChange={(event) => onChange({ required: event.target.checked })}
              />
              <span className="toggle-mark" aria-hidden="true" />
              <span>Required</span>
            </label>
          )}
          {showInverse && (
            <label className="toggle-chip">
              <input
                checked={relation.inverse}
                type="checkbox"
                onChange={(event) => onChange({ inverse: event.target.checked })}
              />
              <span className="toggle-mark" aria-hidden="true" />
              <span>Inverse side</span>
            </label>
          )}
          {showMappedBy && (
            <label className="field relation-mapped-by">
              <span className="field-label">Mapped by</span>
              <input
                aria-label={`Relation ${index + 1} mapped by`}
                autoComplete="off"
                placeholder="field on the other side"
                value={relation.mappedBy}
                onChange={(event) => onChange({ mappedBy: event.target.value })}
              />
            </label>
          )}
        </div>
      </div>
    </article>
  );
}

function previewFileLabel(file: EntityPreviewFile): string {
  const segments = file.path.split('/');
  return segments.slice(-2).join('/');
}
