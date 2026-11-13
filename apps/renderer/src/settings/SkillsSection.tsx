// 设置 › 扩展 › Skill：列出、添加（选择目录）、删除（仅单独添加的），并显示问题与冲突。

import { useCallback, useEffect, useState } from 'react';
import type { SkillInfo, SkillProblem } from '@minibot/core';
import type { Api } from '../api';
import { t } from '../i18n';
import { cn } from '../lib/cn';
import { BUTTON, SETTINGS_CARD, SettingsGroup, errorText } from '../ui/settings';

export function SkillsSection({ api }: { api: Api }) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [problems, setProblems] = useState<SkillProblem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.skills().then(
      (r) => {
        setSkills(r.skills);
        setProblems(r.problems);
      },
      (err: unknown) => setError(errorText(err)),
    );
  }, [api]);

  useEffect(() => { refresh(); }, [refresh]);

  const add = async (): Promise<void> => {
    setError(null);
    try {
      const dir = await window.minibot?.pickFolder?.();
      if (dir === null || dir === undefined) return;
      await api.addSkill(dir);
      refresh();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const remove = async (skill: SkillInfo): Promise<void> => {
    setBusy(skill.id);
    setError(null);
    try {
      await api.removeSkill(skill.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  return (
    <SettingsGroup
      label={t('skills.title')}
      actions={<button type="button" className={BUTTON} onClick={() => void add()}>{t('skills.add')}</button>}>
      {error !== null && <p className="pl-4 text-[12px] text-danger">{error}</p>}
      {skills.length === 0 ? (
        <p className={cn(SETTINGS_CARD, 'px-4 py-6 text-[13px] text-ink-secondary')}>{t('skills.empty')}</p>
      ) : (
        <div className={cn(SETTINGS_CARD, 'flex flex-col divide-y divide-hairline')}>
          {skills.map((skill) => (
            <div key={skill.id} className="flex flex-col gap-1 px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{skill.name}</span>
                <span className="shrink-0 text-[12px] text-ink-secondary">
                  {skill.origin.kind === 'user' ? t('skills.origin.user') : t('skills.origin.plugin', { name: skill.origin.pluginName })}
                </span>
                {skill.origin.kind === 'user' && (
                  <button type="button" disabled={busy === skill.id} className={cn(BUTTON, 'text-danger')} onClick={() => void remove(skill)}>
                    {t('skills.delete')}
                  </button>
                )}
              </div>
              <p className="min-w-0 text-[12px] text-ink-secondary">{skill.description}</p>
              {skill.shadowed && <p className="text-[12px] text-warning">{t('skills.conflict')}</p>}
            </div>
          ))}
        </div>
      )}
      {problems.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="pl-4 text-[12px] font-medium text-ink-secondary">{t('skills.problems')}</p>
          {problems.map((p) => (
            <p key={p.dir} className="min-w-0 break-words pl-4 text-[12px] text-danger">
              {p.dir}：{p.reason}
            </p>
          ))}
        </div>
      )}
    </SettingsGroup>
  );
}
