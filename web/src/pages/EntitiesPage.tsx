import { useState, type FormEvent } from 'react';
import type {
  CommandResult,
  CreateEntityRequest,
  EntityFieldRequest,
} from '../../../src/web/contracts';
import { api } from '../api';
import { CommandConsole } from '../components/CommandConsole';
import { Icon } from '../components/Icon';
import { NoProjectState, ProblemAlert, ProjectPicker } from '../components/StatePanels';
import { titleCase } from '../format';
import { errorDetails, useWorkspace } from '../workspace';

type FieldType = CreateEntityRequest['fields'][number]['type'];

interface FieldRow {
  key: string;
  name: string;
  type: FieldType;
  required: boolean;
  unique: boolean;
  maxLength: string;
}

let fieldKey = 0;

function newFieldRow(): FieldRow {
  fieldKey += 1;
  return {
    key: `field-${fieldKey}`,
    name: '',
    type: 'String',
    required: false,
    unique: false,
    maxLength: '',
  };
}

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function EntitiesPage() {
  const { projects, meta, selectedProject, refresh } = useWorkspace();
  const [entityName, setEntityName] = useState('');
  const [tableName, setTableName] = useState('');
  const [fields, setFields] = useState<FieldRow[]>([newFieldRow()]);
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<{ message: string; suggestions: string[] } | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const [result, setResult] = useState<CommandResult | null>(null);

  const updateField = <Key extends keyof FieldRow>(
    key: string,
    property: Key,
    value: FieldRow[Key],
  ): void => {
    setFields((current) =>
      current.map((field) => (field.key === key ? { ...field, [property]: value } : field)),
    );
    setValidation(null);
  };

  const removeField = (key: string): void => {
    setFields((current) => {
      if (current.length === 1) return current;
      return current.filter((field) => field.key !== key);
    });
  };

  const addField = (): void => {
    setFields((current) => [...current, newFieldRow()]);
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (selectedProject === null) return;

    const name = entityName.trim();
    if (!IDENTIFIER_PATTERN.test(name)) {
      setValidation('Entity names must be valid identifiers, for example Product.');
      return;
    }

    const prepared: EntityFieldRequest[] = [];
    const seen = new Set<string>();
    for (const field of fields) {
      const fieldName = field.name.trim();
      if (!IDENTIFIER_PATTERN.test(fieldName)) {
        setValidation('Every field needs a valid identifier name, for example productName.');
        return;
      }
      if (seen.has(fieldName.toLowerCase())) {
        setValidation(`The field "${fieldName}" is defined more than once.`);
        return;
      }
      seen.add(fieldName.toLowerCase());

      const preparedField: EntityFieldRequest = { name: fieldName, type: field.type };
      if (field.required) preparedField.required = true;
      if (field.unique) preparedField.unique = true;
      if (field.maxLength.trim() !== '') {
        const maxLength = Number(field.maxLength);
        if (!Number.isInteger(maxLength) || maxLength <= 0) {
          setValidation(`Max length for "${fieldName}" must be a positive whole number.`);
          return;
        }
        if (field.type !== 'String') {
          setValidation(`Max length only applies to String fields, not "${fieldName}".`);
          return;
        }
        preparedField.maxLength = maxLength;
      }
      prepared.push(preparedField);
    }

    const request: CreateEntityRequest = {
      projectPath: selectedProject.rootDir,
      name,
      fields: prepared,
    };
    if (tableName.trim() !== '') request.tableName = tableName.trim();

    setSubmitting(true);
    setProblem(null);
    setResult(null);
    try {
      const response = await api.createEntity(request);
      setResult(response);
      await refresh(selectedProject.rootDir);
      setEntityName('');
      setTableName('');
      setFields([newFieldRow()]);
      setValidation(null);
    } catch (caught) {
      setProblem(errorDetails(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const fieldTypes = meta?.fieldTypes ?? ['String', 'int', 'boolean', 'UUID', 'LocalDate'];

  return (
    <div className="page entities-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">
            <Icon name="database" size={15} />
            Entities, generated everywhere
          </span>
          <h1>Manage entities</h1>
          <p>
            Describe a domain model once. The shared engine generates the JPA entity, migration,
            repository, API, DTOs, Angular page, and routes.
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
                  The newest entity is recorded in <code>.cleanstack/project.json</code> and
                  generated across the stack.
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

          <div className="entity-layout">
            <form className="card form-card entity-form" onSubmit={(event) => void submit(event)}>
              <div className="card-heading">
                <div>
                  <span className="section-kicker">New entity</span>
                  <h2>Model the domain</h2>
                </div>
                <span className="form-step">
                  {fields.length} field{fields.length === 1 ? '' : 's'}
                </span>
              </div>

              <div className="form-grid">
                <label className="field">
                  <span className="field-label">Entity name</span>
                  <input
                    autoComplete="off"
                    placeholder="Product"
                    value={entityName}
                    onChange={(event) => {
                      setEntityName(event.target.value);
                      setValidation(null);
                    }}
                  />
                  <span className="field-hint">Use a singular PascalCase name.</span>
                </label>

                <label className="field">
                  <span className="field-label">Table name</span>
                  <input
                    autoComplete="off"
                    placeholder="products (optional)"
                    value={tableName}
                    onChange={(event) => {
                      setTableName(event.target.value);
                      setValidation(null);
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
                      Types and rules are validated by the same engine as the CLI.
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

                <div className="field-table">
                  <div className="field-table-head" aria-hidden="true">
                    <span>Name</span>
                    <span>Type</span>
                    <span>Required</span>
                    <span>Unique</span>
                    <span>Max length</span>
                    <span />
                  </div>

                  {fields.map((field, index) => (
                    <div className="field-row" key={field.key}>
                      <label className="field-cell">
                        <span className="mobile-label">Name</span>
                        <input
                          aria-label={`Field ${index + 1} name`}
                          autoComplete="off"
                          placeholder={index === 0 ? 'name' : 'fieldName'}
                          value={field.name}
                          onChange={(event) => updateField(field.key, 'name', event.target.value)}
                        />
                      </label>
                      <label className="field-cell">
                        <span className="mobile-label">Type</span>
                        <select
                          aria-label={`Field ${index + 1} type`}
                          value={field.type}
                          onChange={(event) =>
                            updateField(field.key, 'type', event.target.value as FieldType)
                          }
                        >
                          {fieldTypes.map((type) => (
                            <option key={type} value={type}>
                              {type}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field-toggle">
                        <input
                          checked={field.required}
                          type="checkbox"
                          onChange={(event) =>
                            updateField(field.key, 'required', event.target.checked)
                          }
                        />
                        <span className="toggle-mark" aria-hidden="true" />
                        <span className="mobile-label">Required</span>
                      </label>
                      <label className="field-toggle">
                        <input
                          checked={field.unique}
                          type="checkbox"
                          onChange={(event) =>
                            updateField(field.key, 'unique', event.target.checked)
                          }
                        />
                        <span className="toggle-mark" aria-hidden="true" />
                        <span className="mobile-label">Unique</span>
                      </label>
                      <label className="field-cell">
                        <span className="mobile-label">Max length</span>
                        <input
                          aria-label={`Field ${index + 1} max length`}
                          inputMode="numeric"
                          placeholder="—"
                          value={field.maxLength}
                          onChange={(event) =>
                            updateField(field.key, 'maxLength', event.target.value)
                          }
                        />
                      </label>
                      <button
                        aria-label={`Remove field ${index + 1}`}
                        className="icon-button field-remove"
                        disabled={fields.length === 1}
                        onClick={() => removeField(field.key)}
                        type="button"
                      >
                        <Icon name="trash" size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {validation !== null && <p className="field-error">{validation}</p>}

              <div className="form-actions">
                <span className="form-footnote">
                  <Icon name="layers" size={15} />
                  Protected regions and metadata are updated by the engine.
                </span>
                <button className="button button-primary" disabled={submitting} type="submit">
                  {submitting ? (
                    <>
                      <span className="spinner" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Icon name="database" size={17} />
                      Generate entity
                    </>
                  )}
                </button>
              </div>
            </form>

            <aside className="entity-aside">
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
                      <article className="entity-card" key={entity.name}>
                        <div className="entity-card-heading">
                          <span className="entity-avatar">{entity.name.slice(0, 2)}</span>
                          <div>
                            <strong>{entity.name}</strong>
                            <span>{entity.tableName ?? `${titleCase(entity.name)} table`}</span>
                          </div>
                          <span className="entity-field-count">
                            {entity.fields.length} field{entity.fields.length === 1 ? '' : 's'}
                          </span>
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
                    Backend and frontend artifacts come from the manifests in{' '}
                    <code>templates/</code>. The studio never renders them itself.
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
          Regenerating an existing entity updates generated files while preserving protected
          regions. Use the CLI with <code>--force</code> when you intentionally want a full
          overwrite.
        </span>
      </div>
    </div>
  );
}
