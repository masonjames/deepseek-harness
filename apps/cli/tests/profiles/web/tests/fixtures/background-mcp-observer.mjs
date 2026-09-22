/** Test-only IPC observation of the actual tool registry and graceful shutdown. */
export const inject = ['tools']

export function apply(ctx) {
  const receive = message => {
    if (message === 'stop') process.emit('SIGTERM')
    if (message === 'tools') process.send(ctx.tools.schemas().map(tool => tool.name))
  }
  ctx.effect(() => {
    process.on('message', receive)
    return () => process.off('message', receive)
  })
}
