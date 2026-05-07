// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ProjectList } from '../../src/renderer/views/ProjectList';
import type { ProjectInstanceDto } from '../../src/shared/ipc';

/**
 * LIST-001..008 — <ProjectList> view.
 *
 * Per the spec, ProjectList accepts props: { projects, loading, error,
 * onRefresh, onAdd, onOpen }. We drive the props directly so we don't have
 * to mock the useProjects() hook — that pattern matches the App.tsx usage
 * shown in the spec.
 *
 * Auto Mode (LIST-006) is owned by useAutoMode() inside the view, which is
 * localStorage-backed. We test that clicking the toggle writes the
 * `auto-mode` key to localStorage.
 */

function makeProject(id: string, name: string): ProjectInstanceDto {
  return {
    id,
    name,
    repo: {
      type: 'github',
      localPath: '/tmp/' + id,
      baseBranch: 'main',
      connectionId: 'conn-gh-1',
      slug: 'gazhang/repo',
    },
    tickets: {
      source: 'jira',
      connectionId: 'conn-jr-1',
      projectKey: 'ABC',
      query: 'project = ABC',
    },
    workflow: { mode: 'interactive', branchFormat: 'feature/{ticketKey}-{slug}' },
    createdAt: 0,
    updatedAt: 0,
  };
}

const noop = () => {};
const noopAsync = async () => {};

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('<ProjectList /> — LIST', () => {
  it('LIST-001: renders heading, subhead, Auto Mode toggle, and New Project button', () => {
    render(
      <ProjectList
        projects={[]}
        loading={false}
        error={null}
        onRefresh={noopAsync}
        onAdd={noop}
        onOpen={noop}
      />,
    );

    expect(screen.getByTestId('page-title')).toHaveTextContent(/projects/i);
    // Subhead exact-ish per spec
    expect(screen.getByText(/manage and run/i)).toBeInTheDocument();
    expect(screen.getByTestId('auto-mode-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('new-project-button')).toBeInTheDocument();
  });

  it('LIST-002: empty state when projects=[]; CTA opens dialog', () => {
    const onAdd = vi.fn();
    render(
      <ProjectList
        projects={[]}
        loading={false}
        error={null}
        onRefresh={noopAsync}
        onAdd={onAdd}
        onOpen={noop}
      />,
    );

    expect(screen.getByText(/no projects yet/i)).toBeInTheDocument();
    // Table must NOT be visible
    expect(screen.queryByTestId('project-list-table')).not.toBeInTheDocument();

    const cta = screen.getByTestId('empty-state-cta');
    fireEvent.click(cta);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('LIST-003: populated state shows N rows with project-row-{id} testids', () => {
    const projects = [
      makeProject('p-1', 'Alpha'),
      makeProject('p-2', 'Beta'),
      makeProject('p-3', 'Gamma'),
    ];
    render(
      <ProjectList
        projects={projects}
        loading={false}
        error={null}
        onRefresh={noopAsync}
        onAdd={noop}
        onOpen={noop}
      />,
    );

    expect(screen.getByTestId('project-row-p-1')).toBeInTheDocument();
    expect(screen.getByTestId('project-row-p-2')).toBeInTheDocument();
    expect(screen.getByTestId('project-row-p-3')).toBeInTheDocument();
  });

  it('LIST-004: clicking + New Project fires onAdd', () => {
    const onAdd = vi.fn();
    render(
      <ProjectList
        projects={[makeProject('p-1', 'Alpha')]}
        loading={false}
        error={null}
        onRefresh={noopAsync}
        onAdd={onAdd}
        onOpen={noop}
      />,
    );

    fireEvent.click(screen.getByTestId('new-project-button'));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('LIST-005: clicking Open → fires onOpen with the row id', () => {
    const onOpen = vi.fn();
    render(
      <ProjectList
        projects={[makeProject('p-1', 'Alpha'), makeProject('p-2', 'Beta')]}
        loading={false}
        error={null}
        onRefresh={noopAsync}
        onAdd={noop}
        onOpen={onOpen}
      />,
    );

    fireEvent.click(screen.getByTestId('project-open-p-2'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith('p-2');
  });

  it('LIST-006: Auto Mode toggle persists to localStorage', () => {
    render(
      <ProjectList
        projects={[]}
        loading={false}
        error={null}
        onRefresh={noopAsync}
        onAdd={noop}
        onOpen={noop}
      />,
    );

    const toggle = screen.getByTestId('auto-mode-toggle');
    fireEvent.click(toggle);

    // The key is `auto-mode` per spec
    const stored = localStorage.getItem('auto-mode');
    expect(stored).not.toBeNull();
    // Either "true" or JSON-encoded true — both are acceptable; we
    // just guard that *something* was written.
    expect(stored).toMatch(/true/i);
  });

  it('LIST-007: loading state shows a loading indicator and not the table', () => {
    render(
      <ProjectList
        projects={[]}
        loading={true}
        error={null}
        onRefresh={noopAsync}
        onAdd={noop}
        onOpen={noop}
      />,
    );

    expect(screen.getByTestId('project-list-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('project-list-table')).not.toBeInTheDocument();
  });

  it('LIST-008: error state shows banner + Retry triggers onRefresh', () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectList
        projects={[]}
        loading={false}
        error="Something went wrong"
        onRefresh={onRefresh}
        onAdd={noop}
        onOpen={noop}
      />,
    );

    expect(screen.getByTestId('project-list-error')).toBeInTheDocument();
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();

    const retry = screen.getByTestId('project-list-retry');
    fireEvent.click(retry);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
