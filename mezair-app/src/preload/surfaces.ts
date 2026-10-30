import { ipcRenderer } from 'electron';
import type { SurfacesApi } from '../shared/surfaces/ipc.js';

export const surfacesBridge: SurfacesApi = {
  listValidations: (workspaceId, workItemRef) =>
    ipcRenderer.invoke('surfaces:list-validations', workspaceId, workItemRef),
  runAction: (request) => ipcRenderer.invoke('surfaces:run-action', request),
  listComments: (surfaceId) => ipcRenderer.invoke('surfaces:list-comments', surfaceId),
  addComment: (input) => ipcRenderer.invoke('surfaces:add-comment', input),
  setCommentStatus: (commentId, status) =>
    ipcRenderer.invoke('surfaces:set-comment-status', commentId, status),
  getSketch: (sketchId) => ipcRenderer.invoke('surfaces:get-sketch', sketchId),
  keepSketch: (sketchId, title) => ipcRenderer.invoke('surfaces:keep-sketch', sketchId, title),
  getArtifact: (artifactId) => ipcRenderer.invoke('surfaces:get-artifact', artifactId),
  listArtifactRevisions: (artifactId) =>
    ipcRenderer.invoke('surfaces:list-artifact-revisions', artifactId),
  getArtifactRevision: (artifactId, version) =>
    ipcRenderer.invoke('surfaces:get-artifact-revision', artifactId, version),
};
