import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Last line of defence for the renderer.
 *
 * Without a boundary, any throw during render unmounts the whole React tree and
 * the user sees an empty window with no explanation - which is exactly how a
 * one-line IPC shape mismatch once presented itself. With one, the same failure
 * becomes a readable, recoverable screen: reload, or copy the stack for a report.
 *
 * Styling is inline on purpose: this screen must survive the failure modes it
 * reports, including a broken stylesheet.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] uncaught render error', error, info.componentStack)
  }

  private copy = (): void => {
    // `state` is never nullish on a class component; only `error` is.
    const text = `${this.state.error?.message ?? ''}\n${this.state.error?.stack ?? ''}`
    try {
      void window.api?.copyText(text)
    } catch {
      /* the bridge itself may be unavailable */
    }
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children

    const error = this.state.error
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0b0b0f',
          color: '#e8e8ee',
          font: '13px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif',
          padding: 32
        }}
      >
        <div style={{ maxWidth: 620, width: '100%' }}>
          <h1 style={{ fontSize: 16, margin: '0 0 8px', fontWeight: 650 }}>
            界面渲染出错 / The interface hit a rendering error
          </h1>
          <p style={{ margin: '0 0 12px', color: '#9a9aa8' }}>
            你的数据（账户、下载队列、设置）都在磁盘上，没有丢失。重新加载即可恢复；若反复出现，请复制错误信息反馈。
          </p>
          <pre
            style={{
              background: '#15151c',
              border: '1px solid #26262f',
              borderRadius: 8,
              padding: 12,
              maxHeight: 220,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              font: '11.5px/1.5 ui-monospace, Menlo, Consolas, monospace',
              color: '#f87171'
            }}
          >
            {error.message}
            {'\n'}
            {error.stack}
          </pre>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                background: '#4f8cff',
                color: '#fff',
                border: 'none',
                borderRadius: 7,
                height: 32,
                padding: '0 14px',
                font: 'inherit',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              重新加载 / Reload
            </button>
            <button
              type="button"
              onClick={this.copy}
              style={{
                background: '#1b1b24',
                color: '#e8e8ee',
                border: '1px solid #34343f',
                borderRadius: 7,
                height: 32,
                padding: '0 14px',
                font: 'inherit',
                cursor: 'pointer'
              }}
            >
              复制错误 / Copy error
            </button>
          </div>
        </div>
      </div>
    )
  }
}
