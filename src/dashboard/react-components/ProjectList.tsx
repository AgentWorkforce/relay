/**
 * ProjectList Component
 *
 * Displays projects with nested agents in a flat hierarchy.
 * Each project is a collapsible section with its agents listed directly underneath.
 */

import React, { useState, useMemo, useEffect } from 'react';
import type { Agent, Project } from '../types';
import { AgentCard } from './AgentCard';
import { STATUS_COLORS, getAgentColor } from '../lib/colors';

/**
 * Gets the simple display name for an agent within a team group.
 * Since the team header already shows context, just show the agent's role/name.
 *
 * Examples:
 * - "Frontend-Lead" in team "Frontend" → "Lead"
 * - "Lead" in team "Lead" → "Lead"
 * - "backend-api" in team "backend" → "Api"
 */
function stripTeamPrefix(agentName: string, teamName: string): string {
  const lowerAgent = agentName.toLowerCase();
  const lowerTeam = teamName.toLowerCase().replace(/-?team$/i, '');

  // Pattern 1: Team prefix with dash separator (e.g., "frontend-lead" → "lead")
  if (lowerTeam && lowerAgent.startsWith(lowerTeam + '-')) {
    const stripped = agentName.substring(lowerTeam.length + 1);
    return capitalizeWords(stripped);
  }

  // Pattern 2: Team prefix with underscore separator
  if (lowerTeam && lowerAgent.startsWith(lowerTeam + '_')) {
    const stripped = agentName.substring(lowerTeam.length + 1);
    return capitalizeWords(stripped);
  }

  // Pattern 3: Last segment of hyphenated name (e.g., "LeadFrontend-Dev" → "Dev")
  const parts = agentName.split('-');
  if (parts.length > 1) {
    return capitalizeWords(parts[parts.length - 1]);
  }

  // No prefix to strip, return capitalized original
  return capitalizeWords(agentName);
}

/**
 * Capitalizes words in a string (handles dash and underscore separators)
 */
function capitalizeWords(str: string): string {
  return str
    .split(/[-_]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export interface ProjectListProps {
  projects: Project[];
  localAgents?: Agent[];
  currentProject?: string;
  selectedAgent?: string;
  searchQuery?: string;
  onProjectSelect?: (project: Project) => void;
  onAgentSelect?: (agent: Agent, project?: Project) => void;
  onReleaseClick?: (agent: Agent) => void;
  compact?: boolean;
}

export function ProjectList({
  projects,
  localAgents = [],
  currentProject,
  selectedAgent,
  searchQuery = '',
  onProjectSelect,
  onAgentSelect,
  onReleaseClick,
  compact = false,
}: ProjectListProps) {
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set(projects.map((p) => p.id))
  );

  // Filter projects and agents based on search query
  const filteredData = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) {
      return { projects, localAgents };
    }

    // Filter local agents
    const filteredLocal = localAgents.filter(
      (a) =>
        a.name.toLowerCase().includes(query) ||
        a.currentTask?.toLowerCase().includes(query)
    );

    // Filter projects (show project if name matches OR any agent matches)
    const filteredProjects = projects
      .map((project) => {
        const projectNameMatches =
          project.name?.toLowerCase().includes(query) ||
          project.path.toLowerCase().includes(query);

        const filteredAgents = project.agents.filter(
          (a) =>
            a.name.toLowerCase().includes(query) ||
            a.currentTask?.toLowerCase().includes(query)
        );

        // Include project if name matches or has matching agents
        if (projectNameMatches || filteredAgents.length > 0) {
          return {
            ...project,
            agents: projectNameMatches ? project.agents : filteredAgents,
          };
        }
        return null;
      })
      .filter(Boolean) as Project[];

    return { projects: filteredProjects, localAgents: filteredLocal };
  }, [projects, localAgents, searchQuery]);

  const toggleProject = (projectId: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  };

  const totalAgents =
    filteredData.localAgents.length +
    filteredData.projects.reduce((sum, p) => sum + p.agents.length, 0);

  if (totalAgents === 0 && projects.length === 0 && localAgents.length === 0) {
    return (
      <div className="project-list-empty">
        <EmptyIcon />
        <p>No projects or agents</p>
      </div>
    );
  }

  if (totalAgents === 0 && searchQuery) {
    return (
      <div className="project-list-empty">
        <SearchIcon />
        <p>No results for "{searchQuery}"</p>
      </div>
    );
  }

  return (
    <div className="project-list">
      {/* Local agents section (current project) */}
      {filteredData.localAgents.length > 0 && (
        <ProjectSection
          project={{
            id: '__local__',
            path: '',
            name: 'Local',
            agents: filteredData.localAgents,
          }}
          isExpanded={expandedProjects.has('__local__')}
          isCurrentProject={true}
          selectedAgent={selectedAgent}
          compact={compact}
          onToggle={() => toggleProject('__local__')}
          onAgentSelect={(agent) => onAgentSelect?.(agent)}
          onReleaseClick={onReleaseClick}
        />
      )}

      {/* Bridged projects */}
      {filteredData.projects.map((project) => (
        <ProjectSection
          key={project.id}
          project={project}
          isExpanded={expandedProjects.has(project.id)}
          isCurrentProject={project.id === currentProject}
          selectedAgent={selectedAgent}
          compact={compact}
          onToggle={() => toggleProject(project.id)}
          onProjectSelect={() => onProjectSelect?.(project)}
          onAgentSelect={(agent) => onAgentSelect?.(agent, project)}
          onReleaseClick={onReleaseClick}
        />
      ))}
    </div>
  );
}

interface ProjectSectionProps {
  project: Project;
  isExpanded: boolean;
  isCurrentProject: boolean;
  selectedAgent?: string;
  compact?: boolean;
  onToggle: () => void;
  onProjectSelect?: () => void;
  onAgentSelect?: (agent: Agent) => void;
  onReleaseClick?: (agent: Agent) => void;
}

interface TeamGroup {
  name: string;
  agents: Agent[];
}

function ProjectSection({
  project,
  isExpanded,
  isCurrentProject,
  selectedAgent,
  compact,
  onToggle,
  onProjectSelect,
  onAgentSelect,
  onReleaseClick,
}: ProjectSectionProps) {
  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(new Set());

  const stats = useMemo(() => {
    let online = 0;
    let needsAttention = 0;
    for (const agent of project.agents) {
      if (agent.status === 'online') online++;
      if (agent.needsAttention) needsAttention++;
    }
    return { online, needsAttention, total: project.agents.length };
  }, [project.agents]);

  // Group agents by team (optional user-defined grouping)
  const { teams, ungroupedAgents } = useMemo(() => {
    const teamMap = new Map<string, Agent[]>();
    const ungrouped: Agent[] = [];

    for (const agent of project.agents) {
      if (agent.team) {
        const existing = teamMap.get(agent.team) || [];
        existing.push(agent);
        teamMap.set(agent.team, existing);
      } else {
        ungrouped.push(agent);
      }
    }

    const teams: TeamGroup[] = Array.from(teamMap.entries())
      .map(([name, agents]) => ({ name, agents }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { teams, ungroupedAgents: ungrouped };
  }, [project.agents]);

  const toggleTeam = (teamName: string) => {
    setExpandedTeams((prev) => {
      const next = new Set(prev);
      if (next.has(teamName)) {
        next.delete(teamName);
      } else {
        next.add(teamName);
      }
      return next;
    });
  };

  // Auto-expand teams when project expands
  useEffect(() => {
    if (isExpanded && expandedTeams.size === 0 && teams.length > 0) {
      setExpandedTeams(new Set(teams.map((t) => t.name)));
    }
  }, [isExpanded, teams, expandedTeams]);

  const projectColor = getAgentColor(project.name || project.id);
  const displayName = project.name || project.path.split('/').pop() || project.id;

  return (
    <div className={`project-section ${isCurrentProject ? 'current' : ''}`}>
      <button
        className="project-header"
        onClick={onToggle}
        onDoubleClick={onProjectSelect}
        style={{
          '--project-color': projectColor.primary,
          '--project-light': projectColor.light,
        } as React.CSSProperties}
      >
        <div className="project-color-bar" />
        <ChevronIcon expanded={isExpanded} />
        <FolderIcon />
        <span className="project-name">{displayName}</span>
        <span className="project-count">({stats.total})</span>

        <div className="project-stats">
          {stats.online > 0 && (
            <span className="stat online">
              <span
                className="stat-dot"
                style={{ backgroundColor: STATUS_COLORS.online }}
              />
              {stats.online}
            </span>
          )}
          {stats.needsAttention > 0 && (
            <span className="stat attention">
              <span
                className="stat-dot"
                style={{ backgroundColor: STATUS_COLORS.attention }}
              />
              {stats.needsAttention}
            </span>
          )}
        </div>

        {project.lead?.connected && (
          <span className="lead-indicator" title={`Lead: ${project.lead.name}`}>
            ★
          </span>
        )}
      </button>

      {isExpanded && (
        <div className="project-agents">
          {/* Team groups (optional user-defined) */}
          {teams.map((team) => (
            <div key={team.name} className="team-group">
              <button
                className="team-header"
                onClick={() => toggleTeam(team.name)}
              >
                <ChevronIcon expanded={expandedTeams.has(team.name)} />
                <TeamIcon />
                <span className="team-name">{team.name}</span>
                <span className="team-count">({team.agents.length})</span>
              </button>
              {expandedTeams.has(team.name) && (
                <div className="team-agents">
                  {team.agents.map((agent) => (
                    <AgentCard
                      key={agent.name}
                      agent={agent}
                      isSelected={agent.name === selectedAgent}
                      compact={compact}
                      displayNameOverride={stripTeamPrefix(agent.name, team.name)}
                      onClick={onAgentSelect}
                      onReleaseClick={onReleaseClick}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* Ungrouped agents (no team assigned) */}
          {ungroupedAgents.map((agent) => (
            <AgentCard
              key={agent.name}
              agent={agent}
              isSelected={agent.name === selectedAgent}
              compact={compact}
              onClick={onAgentSelect}
              onReleaseClick={onReleaseClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`chevron-icon ${expanded ? 'expanded' : ''}`}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      className="folder-icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function TeamIcon() {
  return (
    <svg
      className="team-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function EmptyIcon() {
  return (
    <svg
      width="48"
      height="48"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      width="48"
      height="48"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

/**
 * CSS styles for the project list
 */
export const projectListStyles = `
.project-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.project-list-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  color: #888;
  text-align: center;
}

.project-list-empty svg {
  margin-bottom: 12px;
  opacity: 0.5;
}

.project-section {
  margin-bottom: 4px;
}

.project-section.current .project-header {
  background: rgba(0, 255, 200, 0.08);
}

.project-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 13px;
  text-align: left;
  border-radius: 6px;
  transition: background 0.2s;
  position: relative;
  color: #e8e8e8;
}

.project-header:hover {
  background: var(--project-light);
}

.project-color-bar {
  position: absolute;
  left: 0;
  top: 4px;
  bottom: 4px;
  width: 3px;
  background: var(--project-color);
  border-radius: 2px;
}

.folder-icon {
  color: var(--project-color);
  flex-shrink: 0;
}

.project-name {
  font-weight: 600;
  color: #e8e8e8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.project-count {
  color: #888;
  font-weight: normal;
  flex-shrink: 0;
}

.project-stats {
  margin-left: auto;
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.stat {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #666;
}

.stat-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.lead-indicator {
  color: #ffd700;
  font-size: 12px;
  margin-left: 4px;
}

.project-agents {
  padding: 4px 0 4px 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.chevron-icon {
  transition: transform 0.2s;
  color: #888;
  flex-shrink: 0;
}

.chevron-icon.expanded {
  transform: rotate(90deg);
}

/* Team grouping styles */
.team-group {
  margin-bottom: 2px;
}

.team-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12px;
  text-align: left;
  border-radius: 4px;
  transition: background 0.2s;
  color: #b8b8b8;
}

.team-header:hover {
  background: rgba(255, 255, 255, 0.05);
}

.team-icon {
  color: #888;
  flex-shrink: 0;
}

.team-name {
  font-weight: 500;
  color: #b8b8b8;
}

.team-count {
  color: #666;
  font-weight: normal;
}

.team-agents {
  padding: 2px 0 2px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
`;
