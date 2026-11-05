import { useEffect, useState } from 'react';
import { Icon } from './Icons';
import { Sheet } from './Overlays';
import { useI18n } from '../i18n/I18nContext';
import type { Language } from '../types';
import {
  CAPABILITIES,
  MODELS,
  PERSONAS,
  type CapabilityOption,
  type ModelOption,
  type PersonaDefinition,
  type PersonaId,
  type ProjectOption
} from '../data/personas';

function bilingual(value: { en: string; zh: string }, lang: Language): string {
  return value[lang === 'zh' ? 'zh' : 'en'];
}

export function PersonaSheet({
  active,
  notes,
  soul,
  skills,
  onSelect,
  onNotes,
  onSoul,
  onSkills,
  onClose,
  extra = []
}: {
  active: PersonaId;
  notes: string;
  soul: string;
  skills: string[];
  onSelect: (id: PersonaId) => void;
  onNotes: (notes: string) => void;
  onSoul: (soul: string) => void;
  onSkills: (skills: string[]) => void;
  onClose: () => void;
  /** Companions offered only when their service is on (the Family companion with Homemind). */
  extra?: PersonaDefinition[];
}) {
  const { lang, tr } = useI18n();
  const [skillText, setSkillText] = useState(skills.join(', '));

  useEffect(() => {
    setSkillText(skills.join(', '));
  }, [active, skills]);

  return (
    <Sheet
      title={tr('Choose a companion', '选择分身')}
      subtitle={tr('Local personas, each with its own tone and memory', '本地分身，各自拥有语气与记忆')}
      onClose={onClose}
      wide
    >
      <div className="persona-list">
        {[...PERSONAS, ...extra].map(persona => {
          const isActive = persona.id === active;
          return (
            <button
              type="button"
              key={persona.id}
              className={`persona-row ${isActive ? 'is-active' : ''}`}
              onClick={() => onSelect(persona.id)}
            >
              <span className="persona-avatar" style={{ background: persona.accent }}>
                {persona.avatar}
              </span>
              <span className="persona-copy">
                <strong>{persona.name[lang === 'zh' ? 'zh' : 'en']}</strong>
                <em>{persona.tagline[lang === 'zh' ? 'zh' : 'en']}</em>
                <span>{persona.skills[lang === 'zh' ? 'zh' : 'en'].join(' · ')}</span>
              </span>
              {isActive ? <Icon name="check" size={16} /> : <Icon name="chevronRight" size={16} />}
            </button>
          );
        })}
      </div>
      <div className="settings-group">
        <span className="settings-label">{tr('Soul and skills', '灵魂与技能')}</span>
        <textarea
          className="field-input persona-notes"
          value={soul}
          onChange={event => onSoul(event.target.value)}
          aria-label={tr('Companion soul', '分身灵魂')}
          rows={3}
        />
        <input
          className="field-input"
          value={skillText}
          onChange={event => setSkillText(event.target.value)}
          onBlur={() =>
            onSkills(
              skillText
                .split(/[,，]/)
                .map(item => item.trim())
                .filter(Boolean)
            )
          }
          placeholder={tr('Skills, separated by commas', '技能，用逗号分隔')}
          aria-label={tr('Companion skills', '分身技能')}
        />
      </div>
      <div className="settings-group">
        <span className="settings-label">{tr('Companion notes', '分身备注')}</span>
        <textarea
          className="field-input persona-notes"
          value={notes}
          onChange={event => onNotes(event.target.value)}
          placeholder={tr('Stable preferences this companion should remember', '这个分身应记住的稳定偏好')}
          aria-label={tr('Companion notes', '分身备注')}
          rows={3}
        />
        <p className="settings-note">
          {tr(
            'Stored locally with this persona. It is included in your local backup.',
            '与当前分身一起保存在本地，并会包含在本地备份中。'
          )}
        </p>
      </div>
    </Sheet>
  );
}

export function ModelSheet({
  selected,
  onSelect,
  onClose
}: {
  selected: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const { lang, tr } = useI18n();
  return (
    <Sheet
      title={tr('Model', '模型')}
      subtitle={tr('Local options work offline; Orbit needs a bridge', '本地选项可离线使用；Orbit 需要桥接')}
      onClose={onClose}
    >
      <div className="option-list">
        {MODELS.map(model => {
          const isActive = model.id === selected;
          return (
            <button
              type="button"
              key={model.id}
              className={`option-row ${isActive ? 'is-active' : ''}`}
              onClick={() => onSelect(model.id)}
            >
              <span>
                <strong>{bilingual(model.name, lang)}</strong>
                <em>{bilingual(model.detail, lang)}</em>
              </span>
              {isActive ? <Icon name="check" size={16} /> : null}
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

export function ProjectSheet({
  projects,
  selected,
  onSelect,
  onAdd,
  onClose
}: {
  projects: ProjectOption[];
  selected: string;
  onSelect: (id: string) => void;
  onAdd: (name: string, path: string) => void;
  onClose: () => void;
}) {
  const { tr } = useI18n();
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  return (
    <Sheet
      title={tr('Project directory', '项目目录')}
      subtitle={tr('A local label for this task; no files are uploaded', '任务的本地标签，不会上传文件')}
      onClose={onClose}
    >
      <div className="option-list">
        {projects.map(project => {
          const isActive = project.id === selected;
          return (
            <button
              type="button"
              key={project.id}
              className={`option-row ${isActive ? 'is-active' : ''}`}
              onClick={() => onSelect(project.id)}
            >
              <span>
                <strong>{project.name}</strong>
                <em>{project.path || tr('No folder selected', '未选择文件夹')}</em>
              </span>
              {isActive ? <Icon name="check" size={16} /> : null}
            </button>
          );
        })}
      </div>
      <div className="settings-group">
        <span className="settings-label">{tr('Add a local folder label', '添加本地目录标签')}</span>
        <input
          className="field-input"
          value={name}
          onChange={event => setName(event.target.value)}
          placeholder={tr('Project name', '项目名称')}
          aria-label={tr('Project name', '项目名称')}
        />
        <input
          className="field-input"
          value={path}
          onChange={event => setPath(event.target.value)}
          placeholder={tr('/path/to/project', '/项目/路径')}
          aria-label={tr('Project path', '项目路径')}
        />
        <button
          type="button"
          className="secondary-action"
          disabled={!name.trim()}
          onClick={() => {
            onAdd(name.trim(), path.trim());
            setName('');
            setPath('');
          }}
        >
          <Icon name="plus" size={14} />
          {tr('Add project', '添加项目')}
        </button>
      </div>
    </Sheet>
  );
}

export function CapabilitiesSheet({
  selected,
  onToggle,
  onClose
}: {
  selected: string[];
  onToggle: (id: string) => void;
  onClose: () => void;
}) {
  const { lang, tr } = useI18n();
  return (
    <Sheet
      title={tr('Capabilities and tools', '能力与工具')}
      subtitle={tr('Local capabilities work now; MCP entries are demo-only', '本地能力可用；MCP 条目为演示')}
      onClose={onClose}
    >
      <div className="option-list">
        {CAPABILITIES.map(capability => {
          const isActive = selected.includes(capability.id);
          return (
            <button
              type="button"
              key={capability.id}
              className={`option-row ${isActive ? 'is-active' : ''}`}
              onClick={() => onToggle(capability.id)}
            >
              <span>
                <strong>
                  {bilingual(capability.name, lang)}
                  {capability.local ? null : (
                    <em className="capability-badge">{tr('demo', '演示')}</em>
                  )}
                </strong>
                <em>{bilingual(capability.detail, lang)}</em>
              </span>
              <span className={`check-box ${isActive ? 'is-checked' : ''}`}>
                {isActive ? <Icon name="check" size={13} /> : null}
              </span>
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

export function capabilityLabel(id: string, lang: Language): string {
  const capability: CapabilityOption | undefined = CAPABILITIES.find(item => item.id === id);
  return capability ? bilingual(capability.name, lang) : id;
}

export function modelLabel(id: string, lang: Language): string {
  const model: ModelOption | undefined = MODELS.find(item => item.id === id);
  return model ? bilingual(model.name, lang) : id;
}
