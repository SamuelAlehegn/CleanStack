import type { ReactNode } from 'react';
import { routeHref } from '../router';
import { useWorkspace } from '../workspace';
import { Icon, type IconName } from './Icon';

interface ProjectPickerProps {
  label?: string;
  hint?: string;
}

export function ProjectPicker({ label = 'Active project', hint }: ProjectPickerProps) {
  const { projects, selectedPath, selectProject, selectedProject } = useWorkspace();

  if (projects.length === 0) return null;

  return (
    <div className="project-picker">
      <div className="project-picker-copy">
        <span className="field-label">{label}</span>
        {hint !== undefined && <span className="field-hint">{hint}</span>}
      </div>
      <div className="project-picker-control">
        <select
          aria-label={label}
          value={selectedPath ?? ''}
          onChange={(event) => selectProject(event.target.value)}
        >
          {projects.map((project) => (
            <option key={project.rootDir} value={project.rootDir}>
              {project.name}
            </option>
          ))}
        </select>
        <Icon name="chevron-down" size={16} />
      </div>
      {selectedProject !== null && (
        <code className="project-picker-path">{selectedProject.rootDir}</code>
      )}
    </div>
  );
}

interface EmptyStateProps {
  icon: IconName;
  title: string;
  description: string;
  action?: ReactNode;
  secondaryAction?: ReactNode;
}

export function EmptyState({ icon, title, description, action, secondaryAction }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={26} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {(action !== undefined || secondaryAction !== undefined) && (
        <div className="empty-actions">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}

export function NoProjectState() {
  return (
    <EmptyState
      icon="layers"
      title="No generated project yet"
      description="Create a project first. It will appear here, and you can start adding entities or inspecting every generated file."
      action={
        <a className="button button-primary" href={routeHref('new')}>
          <Icon name="plus" size={17} />
          Create a project
        </a>
      }
    />
  );
}

interface ProblemAlertProps {
  message: string;
  suggestions?: string[];
  onDismiss?: () => void;
}

export function ProblemAlert({ message, suggestions = [], onDismiss }: ProblemAlertProps) {
  return (
    <div className="problem-alert" role="alert">
      <span className="problem-icon">
        <Icon name="warning" size={19} />
      </span>
      <div>
        <strong>{message}</strong>
        {suggestions.length > 0 && (
          <ul>
            {suggestions.map((suggestion) => (
              <li key={suggestion}>{suggestion}</li>
            ))}
          </ul>
        )}
      </div>
      {onDismiss !== undefined && (
        <button className="icon-button problem-dismiss" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}
