/** Native registration can finish after the component that requested it has unmounted. */
export function listenFileDrop(
  register: (receive: (paths: string[]) => void) => Promise<() => void>,
  receive: (paths: string[]) => void,
  report: (error: unknown) => void,
): () => void {
  let live = true;
  let unsubscribe: (() => void) | undefined;
  void Promise.resolve().then(() =>
    register((paths) => {
      if (live) receive(paths);
    })
  ).then((stop) => {
    if (live) unsubscribe = stop;
    else stop();
  }).catch(report);
  return () => {
    live = false;
    try {
      unsubscribe?.();
    } catch (error) {
      report(error);
    }
    unsubscribe = undefined;
  };
}
