import { useCallback, useEffect, useRef, useState } from "react";

interface UndoRedoHistoryOptions {
  historyKey: string;
  limit?: number;
  mergeWindowMs?: number;
}

interface UndoRedoHistoryResult {
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
}

const cloneSnapshot = <T,>(value: T): T => structuredClone(value);
const snapshotSignature = (value: unknown) => JSON.stringify(value);

/**
 * Tracks a controlled editor value without changing how the editor owns its state.
 * Consecutive updates are merged so text input and node dragging remain one undo step.
 */
export const useUndoRedoHistory = <T,>(
  value: T,
  onRestore: (value: T) => void,
  options: UndoRedoHistoryOptions,
): UndoRedoHistoryResult => {
  const { historyKey, limit = 50, mergeWindowMs = 400 } = options;
  const onRestoreRef = useRef(onRestore);
  const keyRef = useRef(historyKey);
  const presentRef = useRef(cloneSnapshot(value));
  const presentSignatureRef = useRef(snapshotSignature(value));
  const pastRef = useRef<T[]>([]);
  const futureRef = useRef<T[]>([]);
  const lastRecordedAtRef = useRef(0);
  const [, setRevision] = useState(0);

  onRestoreRef.current = onRestore;

  useEffect(() => {
    const nextSignature = snapshotSignature(value);
    if (keyRef.current !== historyKey) {
      keyRef.current = historyKey;
      presentRef.current = cloneSnapshot(value);
      presentSignatureRef.current = nextSignature;
      pastRef.current = [];
      futureRef.current = [];
      lastRecordedAtRef.current = 0;
      setRevision((current) => current + 1);
      return;
    }
    if (nextSignature === presentSignatureRef.current) return;

    const now = Date.now();
    const mergeWithPrevious = now - lastRecordedAtRef.current <= mergeWindowMs && pastRef.current.length > 0;
    if (!mergeWithPrevious) {
      pastRef.current = [...pastRef.current, cloneSnapshot(presentRef.current)].slice(-limit);
    }
    presentRef.current = cloneSnapshot(value);
    presentSignatureRef.current = nextSignature;
    futureRef.current = [];
    lastRecordedAtRef.current = now;
    setRevision((current) => current + 1);
  }, [historyKey, limit, mergeWindowMs, value]);

  const restore = useCallback((direction: "undo" | "redo") => {
    const source = direction === "undo" ? pastRef.current : futureRef.current;
    if (!source.length) return;

    const target = direction === "undo" ? source[source.length - 1] : source[0];
    if (direction === "undo") {
      pastRef.current = source.slice(0, -1);
      futureRef.current = [cloneSnapshot(presentRef.current), ...futureRef.current];
    } else {
      futureRef.current = source.slice(1);
      pastRef.current = [...pastRef.current, cloneSnapshot(presentRef.current)].slice(-limit);
    }
    presentRef.current = cloneSnapshot(target);
    presentSignatureRef.current = snapshotSignature(target);
    lastRecordedAtRef.current = 0;
    onRestoreRef.current(cloneSnapshot(target));
    setRevision((current) => current + 1);
  }, [limit]);

  return {
    canUndo: pastRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
    undo: useCallback(() => restore("undo"), [restore]),
    redo: useCallback(() => restore("redo"), [restore]),
  };
};
