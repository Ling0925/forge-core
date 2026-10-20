/** One root display slot, shared by hosted search, local tools and child approvals. */
export function createApprovalQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    enqueue(work: () => Promise<boolean> | boolean): Promise<boolean> {
      const result = tail.then(work);
      tail = result.catch(() => false);
      return result;
    },
  };
}
export type ApprovalQueue = ReturnType<typeof createApprovalQueue>;
