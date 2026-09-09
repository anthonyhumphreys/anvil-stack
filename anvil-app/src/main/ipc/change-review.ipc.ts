import { recordReviewAttention } from '../services/change-review-attention.service.js';
import { ipcMain } from 'electron';
import * as review from '../services/change-review.service.js';
import type { ChangeReviewApi } from '../../shared/change-review-types.js';
export function registerChangeReviewHandlers(): void {
  const handlers: {
    [K in keyof ChangeReviewApi]: (...args: Parameters<ChangeReviewApi[K]>) => unknown;
  } = {
    recordAttention: recordReviewAttention,
    linkEvidence: review.linkReviewEvidence,
    unlinkEvidence: review.unlinkReviewEvidence,
    repairFinding: review.repairReviewFinding,
    recordNativeEvidence: review.recordNativeReviewEvidence,
    publish: review.publishChangeReview,
    list: review.listChangeReviews,
    create: review.createChangeReview,
    get: review.getChangeReview,
    refresh: review.refreshChangeReview,
    configure: review.configureChangeReview,
    run: review.runChangeReview,
    cancel: review.cancelChangeReview,
    annotate: review.annotateChangeReview,
    resolveFinding: review.resolveReviewFinding,
    decide: review.decideChangeReview,
    artifact: review.getReviewImage,
    openTrace: review.openReviewTrace,
    export: review.exportChangeReview,
  };
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`change-review:${name}`, (_event, ...args: unknown[]) =>
      (handler as (...args: unknown[]) => unknown)(...args),
    );
  }
}
