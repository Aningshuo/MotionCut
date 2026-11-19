/**
 * 多序列切换器（S73 · WP26 的界面入口）。
 *
 * 数据源只有服务端：`GET /api/projects/:id/sequences`。**不做跨请求缓存**——
 * 面板每次展开都重取一次（任务书 §1.1.6），因为序列列表会被别的窗口/命令行改。
 *
 * 三条硬纪律（都能在验收里被抓到）：
 * 1. 切换走 `PUT …/sequences/current`，成功之后**必须整页重取**（`props.onReload`），
 *    只改标签就是造假；
 * 2. 新建/删除的失败文案里，`code` / `field` / `message` 是服务端原文（`server-error.ts`），
 *    人话与下一步来自 `sequence-errors.ts`，两段各司其职；
 * 3. 删除成功后整个工程条目会被服务端关掉（BLK-R38-1），所以 `props.onDeleted` 里
 *    由 App 重开工程再重取——这里不假装「删完还在」。
 */

import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { createSequence, deleteSequence, listSequences, switchSequence } from './api';
import type { SequenceInfo } from './api';
import { SEQUENCE_DELETE_RULES, SEQUENCE_STAGE_PRESETS, sequenceErrorCopy } from './sequence-errors';
import { viewServerError } from './server-error';
import type { ServerErrorView } from './server-error';

const h = createElement;

export interface SequenceBarProps {
  projectId: string;
  /** The More menu can hide this control while a request is still running. */
  hostOpen: boolean;
  /** 切换成功后 App 要做的「整页重取」（doc / layers / 字幕 / 素材 / 舞台）。 */
  onReload: () => Promise<void>;
  /** 删除成功后 App 要做的「重开工程 + 整页重取」。 */
  onDeleted: () => Promise<void>;
  /** 当前序列（导出面板要显示「将导出：<名字>」并决定要不要带 sequence 字段）。 */
  onCurrent: (sequence: { id: string; name: string }) => void;
  /** 全局忙（保存/导出/导入）：序列操作跟着停。 */
  disabled: boolean;
  onNotify: (kind: 'info' | 'error', text: string) => void;
}

type Status = 'loading' | 'ready' | 'error';
type Dialog = 'none' | 'create' | 'delete';

/** 服务端 409/400 的错误块：原文三行 + 人话 + 下一步。 */
function ErrorBlock(props: { view: ServerErrorView; testId: string; extra?: ReactNode }): ReactNode {
  const copy = sequenceErrorCopy(props.view.code);
  return h(
    'div',
    {
      className: 'seq-error',
      'data-testid': props.testId,
      'data-code': props.view.code,
      'data-field': props.view.field,
    },
    h('div', { className: 'seq-error-head' }, h('strong', null, copy.say), h('code', null, props.view.code)),
    h('p', { className: 'seq-error-next' }, `下一步：${copy.next}`),
    h(
      'dl',
      { className: 'seq-error-raw' },
      h('div', { style: { display: 'contents' } }, h('dt', null, 'field'), h('dd', { 'data-testid': `${props.testId}-field` }, props.view.field === '' ? '—' : props.view.field)),
      h('div', { style: { display: 'contents' } }, h('dt', null, 'message'), h('dd', { 'data-testid': `${props.testId}-message` }, props.view.message === '' ? '—' : props.view.message)),
    ),
    props.extra ?? null,
  );
}

/** @param {SequenceInfo} item */
function stageLabel(item: SequenceInfo): string {
  return item.stage === null ? '画幅未知' : `${item.stage.w}×${item.stage.h}`;
}

export function SequenceBar(props: SequenceBarProps): ReactNode {
  const [status, setStatus] = useState<Status>('loading');
  const [list, setList] = useState<SequenceInfo[]>([]);
  const [current, setCurrent] = useState<string>('');
  const [materialized, setMaterialized] = useState(false);
  const [error, setError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState<'' | 'switch' | 'create' | 'delete'>('');
  const [dialog, setDialog] = useState<Dialog>('none');
  const [draftName, setDraftName] = useState('');
  const [draftPreset, setDraftPreset] = useState('16x9');
  const [dialogError, setDialogError] = useState<ServerErrorView | null>(null);
  const [deleteTarget, setDeleteTarget] = useState('');

  /** 回调放进 ref：宿主每次渲染换一个箭头函数，不能让它触发重新取数。 */
  const propsRef = useRef(props);
  propsRef.current = props;
  const projectIdRef = useRef(props.projectId);
  projectIdRef.current = props.projectId;

  const load = useCallback(async (options: { initial?: boolean } = {}): Promise<void> => {
    const id = projectIdRef.current;
    if (id === '') {
      setStatus('ready');
      setList([]);
      setCurrent('');
      return;
    }
    if (options.initial === true) setStatus('loading');
    try {
      const body = await listSequences(id);
      if (projectIdRef.current !== id) return;
      setList(body.sequences);
      setCurrent(body.current);
      setMaterialized(body.materialized === true);
      setError('');
      setStatus('ready');
    } catch (caught) {
      if (projectIdRef.current !== id) return;
      setError(viewServerError(caught).message);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    setStatus('loading');
    setList([]);
    setCurrent('');
    setMenuOpen(false);
    setDialog('none');
    void load({ initial: true });
  }, [props.projectId, load]);

  useEffect(() => {
    if (props.hostOpen) return;
    setMenuOpen(false);
    setDialog('none');
  }, [props.hostOpen]);

  const currentInfo = useMemo(() => list.find((item) => item.id === current) ?? null, [list, current]);

  /** 当前序列报告给宿主（导出面板要用）。 */
  const reportedRef = useRef('');
  useEffect(() => {
    const id = currentInfo?.id ?? '';
    if (id === '' || id === reportedRef.current) return;
    reportedRef.current = id;
    propsRef.current.onCurrent({ id, name: currentInfo?.name ?? id });
  }, [currentInfo]);

  const toggleMenu = useCallback((): void => {
    if (propsRef.current.disabled) return;
    setMenuOpen((previous) => {
      const next = !previous;
      // 每次展开都重取一次：列表不许活过一次请求生命周期。
      if (next) void load();
      return next;
    });
  }, [load]);

  const doSwitch = useCallback(
    async (id: string): Promise<void> => {
      const projectId = projectIdRef.current;
      if (projectId === '' || busy !== '' || id === current) return;
      setBusy('switch');
      try {
        const result = await switchSequence(projectId, id);
        // 先整页重取，再刷新列表：重取失败也要把列表更新到真状态（不让界面停在旧标签上）。
        await propsRef.current.onReload();
        await load();
        setCurrent(result.current);
        setMenuOpen(false);
        propsRef.current.onNotify('info', `已切到 ${result.current} · 已重取工程数据（doc / 轨道 / layers / 字幕）`);
      } catch (caught) {
        const view = viewServerError(caught);
        propsRef.current.onNotify('error', `${view.code}：${view.message}`);
      } finally {
        setBusy('');
      }
    },
    [busy, current, load],
  );

  const openCreate = useCallback((): void => {
    setDraftName('');
    setDraftPreset('16x9');
    setDialogError(null);
    setDialog('create');
  }, []);

  const openDelete = useCallback((id: string): void => {
    setDeleteTarget(id);
    setDialogError(null);
    setDialog('delete');
  }, []);

  const submitCreate = useCallback(async (): Promise<void> => {
    const projectId = projectIdRef.current;
    if (projectId === '' || busy !== '') return;
    const preset =
      SEQUENCE_STAGE_PRESETS.find((item) => item.id === draftPreset) ??
      { id: '16x9', label: '16:9 横屏', note: '1920×1080', w: 1920, h: 1080 };
    setBusy('create');
    setDialogError(null);
    try {
      const created = await createSequence(projectId, {
        name: draftName.trim(),
        stage: { w: preset.w, h: preset.h },
      });
      await load();
      setDialog('none');
      // 建完把菜单收起来：留着会挡住顶栏，也让人以为「已经切过去了」。
      setMenuOpen(false);
      const stage = created.sequence.stage;
      propsRef.current.onNotify(
        'info',
        `已新建序列 ${created.sequence.id}（${stage === null ? preset.note : `${stage.w}×${stage.h}`}）· 切换过去才会打开它`,
      );
    } catch (caught) {
      setDialogError(viewServerError(caught));
    } finally {
      setBusy('');
    }
  }, [busy, draftName, draftPreset, load]);

  const submitDelete = useCallback(async (): Promise<void> => {
    const projectId = projectIdRef.current;
    if (projectId === '' || deleteTarget === '' || busy !== '') return;
    setBusy('delete');
    setDialogError(null);
    try {
      const removed = await deleteSequence(projectId, deleteTarget);
      // 服务端把整个工程条目关掉了（BLK-R38-1）：由宿主重开 + 重取。
      await propsRef.current.onDeleted();
      await load();
      setDialog('none');
      propsRef.current.onNotify('info', `已删除序列 ${removed.removed}（移进 .film/trash/，没有真删）· 当前仍是 ${removed.current}`);
    } catch (caught) {
      setDialogError(viewServerError(caught));
    } finally {
      setBusy('');
    }
  }, [busy, deleteTarget, load]);

  const globalDisabled = props.disabled || busy !== '';

  const menu = ((): ReactNode => {
    if (status === 'loading') {
      return h(
        'div',
        { className: 'seq-menu', 'data-testid': 'sequence-menu', 'data-status': 'loading', 'data-busy': busy === '' ? 'false' : busy },
        h('div', { className: 'seq-skeleton', 'data-testid': 'sequence-loading' }, h('span', null), h('span', null), h('span', null)),
      );
    }
    if (status === 'error') {
      return h(
        'div',
        { className: 'seq-menu', 'data-testid': 'sequence-menu', 'data-status': 'error', 'data-busy': 'false' },
        h(
          'div',
          { className: 'seq-error', 'data-testid': 'sequence-error', 'data-code': 'SEQUENCES_LIST_FAILED' },
          h('div', { className: 'seq-error-head' }, h('strong', null, '序列列表读不出来'), h('code', null, 'GET /sequences')),
          h('p', { className: 'seq-error-next' }, `下一步：点重试；一直失败就看消息里的原因——${error}`),
          h('button', { className: 'btn tiny', type: 'button', 'data-testid': 'sequence-retry', onClick: () => void load({ initial: true }) }, '重试'),
        ),
      );
    }
    const onlyMain = list.length <= 1 && materialized !== true;
    return h(
      'div',
      { className: 'seq-menu', 'data-testid': 'sequence-menu', 'data-status': 'ready', 'data-busy': busy === '' ? 'false' : busy, 'data-count': String(list.length) },
      onlyMain
        ? h(
            'div',
            { className: 'seq-empty', 'data-testid': 'sequence-empty' },
            h('strong', null, '只有 main 一个序列'),
            h('span', null, '多序列是可选的：main 就是工程根目录里那份 film.html，先新建一条才会有别的。'),
          )
        : null,
      h(
        'div',
        { className: 'seq-rows' },
        ...list.map((item) =>
          h(
            'div',
            {
              className: 'seq-row',
              key: item.id,
              'data-testid': 'sequence-row',
              'data-id': item.id,
              'data-current': item.id === current ? 'true' : 'false',
              'data-missing': item.missing === true ? 'true' : 'false',
              'data-sha': item.filmHtmlSha256 ?? '',
            },
            h('span', { className: 'seq-name' }, item.name),
            h('small', { className: 'seq-stage' }, stageLabel(item)),
            item.missing === true ? h('span', { className: 'seq-flag danger' }, 'film.html 丢失') : null,
            item.id === current
              ? h('span', { className: 'seq-flag ok', 'data-testid': 'sequence-current-flag' }, '当前')
              : h(
                  'button',
                  {
                    className: 'btn tiny',
                    type: 'button',
                    'data-testid': 'sequence-switch',
                    disabled: globalDisabled,
                    onClick: () => void doSwitch(item.id),
                  },
                  busy === 'switch' ? '切换中…' : '切换',
                ),
            item.id === 'main'
              ? h('small', { className: 'seq-note', 'data-testid': 'sequence-main-note' }, '默认 · 不可删')
              : item.id === current
                ? h('small', { className: 'seq-note', 'data-testid': 'sequence-current-note' }, '当前 · 不可删')
                : h(
                    'button',
                    {
                      className: 'btn tiny danger',
                      type: 'button',
                      'data-testid': 'sequence-delete',
                      disabled: globalDisabled,
                      onClick: () => openDelete(item.id),
                    },
                    '删除',
                  ),
          ),
        ),
      ),
      h(
        'div',
        { className: 'seq-foot' },
        h(
          'button',
          { className: 'btn tiny', type: 'button', 'data-testid': 'sequence-new', disabled: globalDisabled, onClick: openCreate },
          '＋ 新建序列',
        ),
        h('small', { className: 'seq-note' }, `索引：${materialized ? '.film/sequences.json' : '未落盘（懒创建）'}`),
      ),
    );
  })();

  const createDialog =
    dialog === 'create'
      ? h(
          'div',
          { className: 'modal-backdrop', 'data-testid': 'sequence-create-backdrop' },
          h(
            'div',
            { className: 'modal seq-modal', 'data-testid': 'sequence-create-dialog', 'data-busy': busy === 'create' ? 'true' : 'false' },
            h('div', { className: 'modal-head' }, h('strong', null, '新建序列'), h('button', { className: 'btn', type: 'button', 'data-testid': 'sequence-create-cancel', onClick: () => setDialog('none') }, '×')),
            h(
              'label',
              { className: 'modal-field' },
              h('span', null, '序列名（也是 id）'),
              h('input', {
                type: 'text',
                'data-testid': 'sequence-name',
                value: draftName,
                placeholder: 'beta',
                disabled: busy === 'create',
                onInput: (event: { target: HTMLInputElement }) => setDraftName(event.target.value),
              }),
            ),
            h(
              'div',
              { className: 'modal-field' },
              h('span', null, '画幅'),
              h(
                'div',
                { className: 'segmented', 'data-testid': 'sequence-stage-presets' },
                ...SEQUENCE_STAGE_PRESETS.map((preset) =>
                  h(
                    'button',
                    {
                      className: `btn${draftPreset === preset.id ? ' active' : ''}`,
                      key: preset.id,
                      type: 'button',
                      'data-testid': `sequence-stage-${preset.id}`,
                      'data-on': draftPreset === preset.id ? 'true' : 'false',
                      disabled: busy === 'create',
                      onClick: () => setDraftPreset(preset.id),
                    },
                    `${preset.label} · ${preset.note}`,
                  ),
                ),
              ),
            ),
            dialogError === null ? null : h(ErrorBlock, { view: dialogError, testId: 'sequence-create-error' }),
            h('p', { className: 'modal-hint' }, '新序列自带一份空的 film.html 与 assets/，与 main 完全隔离；建完不会自动切过去。'),
            h(
              'div',
              { className: 'modal-actions' },
              h('button', { className: 'btn', type: 'button', 'data-testid': 'sequence-create-cancel-2', onClick: () => setDialog('none'), disabled: busy === 'create' }, '取消'),
              h('button', { className: 'btn primary', type: 'button', 'data-testid': 'sequence-create-submit', onClick: () => void submitCreate(), disabled: busy === 'create' }, busy === 'create' ? '创建中…' : '创建'),
            ),
          ),
        )
      : null;

  const deleteDialog =
    dialog === 'delete'
      ? h(
          'div',
          { className: 'modal-backdrop', 'data-testid': 'sequence-delete-backdrop' },
          h(
            'div',
            { className: 'modal seq-modal', 'data-testid': 'sequence-delete-dialog', 'data-target': deleteTarget, 'data-busy': busy === 'delete' ? 'true' : 'false' },
            h('div', { className: 'modal-head' }, h('strong', null, `删除序列 ${deleteTarget}`), h('button', { className: 'btn', type: 'button', 'data-testid': 'sequence-delete-cancel', onClick: () => setDialog('none') }, '×')),
            h('p', { className: 'modal-hint' }, '目录会被移进 .film/trash/，不会真删；重名可以重新建回来。'),
            h(
              'ul',
              { className: 'seq-rules', 'data-testid': 'sequence-delete-rules' },
              ...SEQUENCE_DELETE_RULES.map((rule) =>
                h('li', { key: rule.code, 'data-code': rule.code }, h('code', null, rule.code), h('span', null, rule.text)),
              ),
            ),
            dialogError === null
              ? null
              : h(ErrorBlock, {
                  view: dialogError,
                  testId: 'sequence-delete-error',
                  extra:
                    dialogError.code === 'SEQUENCE_IS_CURRENT'
                      ? h(
                          'button',
                          {
                            className: 'btn tiny',
                            type: 'button',
                            'data-testid': 'sequence-delete-switch',
                            onClick: async () => {
                              setDialog('none');
                              await doSwitch('main');
                            },
                          },
                          '先切到 main',
                        )
                      : null,
                }),
            h(
              'div',
              { className: 'modal-actions' },
              h('button', { className: 'btn', type: 'button', 'data-testid': 'sequence-delete-cancel-2', onClick: () => setDialog('none'), disabled: busy === 'delete' }, '取消'),
              h('button', { className: 'btn danger', type: 'button', 'data-testid': 'sequence-delete-confirm', onClick: () => void submitDelete(), disabled: busy === 'delete' }, busy === 'delete' ? '删除中…' : '删除'),
            ),
          ),
        )
      : null;

  return h(
    'div',
    {
      className: 'seq-bar',
      'data-testid': 'sequence-bar',
      'data-status': status,
      'data-busy': busy,
      'data-current': current,
    },
    h(
      'button',
      {
        className: 'seq-pick',
        type: 'button',
        'data-testid': 'sequence-current',
        'data-seq-id': current,
        'aria-expanded': menuOpen ? 'true' : 'false',
        disabled: props.disabled,
        title: '当前序列（点开可切换 / 新建 / 删除）',
        onClick: toggleMenu,
      },
      h('span', { className: 'seq-mark' }, '序列'),
      h('strong', null, currentInfo?.name ?? (current === '' ? '—' : current)),
      currentInfo?.stage != null ? h('small', null, stageLabel(currentInfo)) : null,
      h('span', { className: 'seq-caret' }, menuOpen ? '▴' : '▾'),
    ),
    menuOpen ? menu : null,
    createDialog,
    deleteDialog,
  );
}
