// 浏览器半区：对话框旁的挂窗。只在有 open 问题时出现。
window.__ModuleLoader__.load({
  id: 'dsh-questions-dock',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const css = {
      bar: {
        display: 'flex', alignItems: 'center', gap: '8px',
        font: '12px/1.5 inherit', color: 'inherit',
        background: 'rgba(127,127,127,0.10)',
        border: '1px solid rgba(127,127,127,0.28)',
        borderRadius: '10px', padding: '4px 10px', cursor: 'pointer',
        opacity: 0.92,
      },
      badge: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        minWidth: '16px', height: '16px', padding: '0 4px', borderRadius: '8px',
        background: '#247bbf', color: '#fff', font: '600 10px/1 inherit',
      },
      card: {
        background: 'rgba(127,127,127,0.08)',
        border: '1px solid rgba(127,127,127,0.28)',
        borderRadius: '10px', padding: '8px 10px', marginBottom: '6px',
        display: 'flex', flexDirection: 'column', gap: '8px',
      },
      row: { display: 'flex', alignItems: 'flex-start', gap: '8px' },
      title: { flex: '1 1 auto', fontSize: '12.5px', lineHeight: '1.5' },
      asked: { opacity: 0.55, fontSize: '10.5px', marginTop: '2px' },
      actions: { display: 'flex', gap: '6px', flexShrink: '0' },
      btn: {
        font: '11.5px/1 inherit', padding: '4px 8px', cursor: 'pointer',
        background: 'transparent', color: 'inherit',
        border: '1px solid rgba(127,127,127,0.35)', borderRadius: '7px',
      },
      btnMain: {
        font: '11.5px/1 inherit', padding: '4px 8px', cursor: 'pointer',
        background: '#247bbf', color: '#fff', border: '1px solid #247bbf', borderRadius: '7px',
      },
      hint: { opacity: 0.5, fontSize: '10.5px' },
    }

    function Dock() {
      const [items, setItems] = useState(null)
      const [expanded, setExpanded] = useState(false)

      const load = useCallback(() => {
        fetch('/dsh-questions/list', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : { items: [] }))
          .then((j) => setItems(Array.isArray(j.items) ? j.items : []))
          .catch(() => setItems([]))
      }, [])

      useEffect(() => {
        load()
        const t = setInterval(load, 8000)
        return () => clearInterval(t)
      }, [load])

      const open = (items || []).filter((i) => i.status === 'open')
      if (!open.length) return null

      const act = (id, status) => {
        fetch('/dsh-questions/update', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, status }),
        }).then(load).catch(() => {})
      }

      if (!expanded) {
        return h('div', { style: { display: 'flex', padding: '2px 0 4px' } },
          h('div', { style: css.bar, onClick: () => setExpanded(true), title: '我还没得到回答的问题' },
            h('span', { style: css.badge }, String(open.length)),
            h('span', null, '我有话想问你'),
          ))
      }

      return h('div', { style: { padding: '2px 0 4px', maxWidth: '720px' } },
        h('div', { style: css.card },
          ...open.map((it) => h('div', { key: it.id, style: css.row },
            h('div', { style: css.title },
              h('div', null, it.title || it.id),
              it.asked ? h('div', { style: css.asked }, it.asked) : null),
            h('div', { style: css.actions },
              h('button', { style: css.btnMain, onClick: () => act(it.id, 'answered'), title: '你在对话里答过了，把它从挂窗里移走' }, '答了'),
              h('button', { style: css.btn, onClick: () => act(it.id, 'deferred'), title: '先记着，等我想好' }, '等我想好'),
              h('button', { style: css.btn, onClick: () => act(it.id, 'dropped'), title: '这个不问了' }, '不问了'),
            ),
          )),
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('span', { style: css.hint }, '放着的也算一种答；不用清空。'),
            h('button', { style: css.btn, onClick: () => setExpanded(false) }, '收起'),
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'questions-dock', order: 40,
        }, Dock))
      },
    }
  },
})
