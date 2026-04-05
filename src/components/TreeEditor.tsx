'use client';

import { useReducer, useEffect, useRef, useCallback } from 'react';

// ── Types ────────────────────────────────────────────────────────────────────

type NodeId = string;

interface TreeNode {
  id: NodeId;
  text: string;
  parentId: NodeId | null;
  childIds: NodeId[];
}

interface CoreState {
  nodes: Record<NodeId, TreeNode>;
  rootIds: NodeId[];
  selectedId: NodeId | null;
  editingId: NodeId | null;
  draft: string;
  bootstrapText: string;
}

// undoStack stores CoreState only — no stack-inside-stack
interface State extends CoreState {
  undoStack: CoreState[];
}

const MAX_UNDO = 10;

function snap(s: State): CoreState {
  return {
    nodes: s.nodes,
    rootIds: s.rootIds,
    selectedId: s.selectedId,
    editingId: s.editingId,
    draft: s.draft,
    bootstrapText: s.bootstrapText,
  };
}

function pushUndo(s: State): CoreState[] {
  return [...s.undoStack.slice(-(MAX_UNDO - 1)), snap(s)];
}

type Action =
  | { type: 'INPUT'; char: string }
  | { type: 'BACKSPACE' }
  | { type: 'CONFIRM_BOOTSTRAP' }
  | { type: 'SELECT'; id: NodeId }
  | { type: 'START_EDIT'; id: NodeId }
  | { type: 'CONFIRM_EDIT' }
  | { type: 'CONFIRM_EDIT_CHILD' }
  | { type: 'CONFIRM_EDIT_SIBLING' }
  | { type: 'QUICK_SIBLING' }
  | { type: 'DELETE_NODE' }
  | { type: 'UNDO' }
  | { type: 'NAVIGATE'; dir: 'up' | 'down' | 'left' | 'right' };

// ── Helpers ──────────────────────────────────────────────────────────────────

let _n = 0;
const uid = (): NodeId => `n${++_n}`;

const makeNode = (text: string, parentId: NodeId | null): TreeNode => ({
  id: uid(),
  text,
  parentId,
  childIds: [],
});

const INIT: State = {
  nodes: {},
  rootIds: [],
  selectedId: null,
  editingId: null,
  draft: '',
  bootstrapText: '',
  undoStack: [],
};

function lastDescendant(nodes: Record<NodeId, TreeNode>, id: NodeId): NodeId {
  const node = nodes[id];
  if (!node.childIds.length) return id;
  return lastDescendant(nodes, node.childIds[node.childIds.length - 1]);
}

function nextSiblingOrAncestor(
  nodes: Record<NodeId, TreeNode>,
  rootIds: NodeId[],
  id: NodeId
): NodeId | null {
  const node = nodes[id];
  const siblings = node.parentId ? nodes[node.parentId].childIds : rootIds;
  const idx = siblings.indexOf(id);
  if (idx < siblings.length - 1) return siblings[idx + 1];
  if (node.parentId) return nextSiblingOrAncestor(nodes, rootIds, node.parentId);
  return null;
}

function navigateNode(
  nodes: Record<NodeId, TreeNode>,
  rootIds: NodeId[],
  id: NodeId,
  dir: 'up' | 'down' | 'left' | 'right'
): NodeId | null {
  const node = nodes[id];
  switch (dir) {
    case 'right':
      return node.childIds[0] ?? null;
    case 'left':
      return node.parentId;
    case 'down':
      if (node.childIds.length) return node.childIds[0];
      return nextSiblingOrAncestor(nodes, rootIds, id);
    case 'up': {
      const siblings = node.parentId ? nodes[node.parentId].childIds : rootIds;
      const idx = siblings.indexOf(id);
      if (idx > 0) return lastDescendant(nodes, siblings[idx - 1]);
      return node.parentId;
    }
  }
}

function collectSubtree(nodes: Record<NodeId, TreeNode>, id: NodeId): NodeId[] {
  return [id, ...nodes[id].childIds.flatMap((c) => collectSubtree(nodes, c))];
}

function insertSiblingAfter(
  nodes: Record<NodeId, TreeNode>,
  rootIds: NodeId[],
  afterId: NodeId,
  sibling: TreeNode
): { nodes: Record<NodeId, TreeNode>; rootIds: NodeId[] } {
  const cur = nodes[afterId];
  const newNodes: Record<NodeId, TreeNode> = { ...nodes, [sibling.id]: sibling };
  let newRootIds = rootIds;

  if (cur.parentId) {
    const parent = nodes[cur.parentId];
    const idx = parent.childIds.indexOf(afterId);
    newNodes[cur.parentId] = {
      ...parent,
      childIds: [
        ...parent.childIds.slice(0, idx + 1),
        sibling.id,
        ...parent.childIds.slice(idx + 1),
      ],
    };
  } else {
    const idx = rootIds.indexOf(afterId);
    newRootIds = [
      ...rootIds.slice(0, idx + 1),
      sibling.id,
      ...rootIds.slice(idx + 1),
    ];
  }

  return { nodes: newNodes, rootIds: newRootIds };
}

// ── Reducer ──────────────────────────────────────────────────────────────────

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'INPUT':
      if (!state.rootIds.length)
        return { ...state, bootstrapText: state.bootstrapText + action.char };
      if (state.editingId)
        return { ...state, draft: state.draft + action.char };
      return state;

    case 'BACKSPACE':
      if (!state.rootIds.length)
        return { ...state, bootstrapText: state.bootstrapText.slice(0, -1) };
      if (state.editingId)
        return { ...state, draft: state.draft.slice(0, -1) };
      return state;

    case 'CONFIRM_BOOTSTRAP': {
      const text = state.bootstrapText.trim();
      if (!text) return state;
      const node = makeNode(text, null);
      return {
        ...state,
        nodes: { [node.id]: node },
        rootIds: [node.id],
        selectedId: node.id,
        bootstrapText: '',
        undoStack: pushUndo(state),
      };
    }

    case 'SELECT':
      if (state.editingId) return state;
      return { ...state, selectedId: action.id };

    case 'START_EDIT': {
      const node = state.nodes[action.id];
      if (!node) return state;
      return { ...state, editingId: action.id, selectedId: action.id, draft: node.text };
    }

    case 'CONFIRM_EDIT': {
      if (!state.editingId) return state;
      const prevText = state.nodes[state.editingId].text;
      const newText = state.draft;
      // Only push undo if text actually changed
      const changed = prevText !== newText;
      return {
        ...state,
        nodes: {
          ...state.nodes,
          [state.editingId]: { ...state.nodes[state.editingId], text: newText },
        },
        editingId: null,
        undoStack: changed ? pushUndo(state) : state.undoStack,
      };
    }

    case 'CONFIRM_EDIT_CHILD': {
      if (!state.editingId) return state;
      const pid = state.editingId;
      const child = makeNode('', pid);
      return {
        ...state,
        nodes: {
          ...state.nodes,
          [pid]: {
            ...state.nodes[pid],
            text: state.draft,
            childIds: [...state.nodes[pid].childIds, child.id],
          },
          [child.id]: child,
        },
        selectedId: child.id,
        editingId: child.id,
        draft: '',
        undoStack: pushUndo(state),
      };
    }

    case 'CONFIRM_EDIT_SIBLING': {
      if (!state.editingId) return state;
      const curId = state.editingId;
      const sibling = makeNode('', state.nodes[curId].parentId);
      const withSaved: Record<NodeId, TreeNode> = {
        ...state.nodes,
        [curId]: { ...state.nodes[curId], text: state.draft },
      };
      const { nodes, rootIds } = insertSiblingAfter(withSaved, state.rootIds, curId, sibling);
      return {
        ...state,
        nodes,
        rootIds,
        selectedId: sibling.id,
        editingId: sibling.id,
        draft: '',
        undoStack: pushUndo(state),
      };
    }

    case 'QUICK_SIBLING': {
      if (!state.selectedId || state.editingId) return state;
      const curId = state.selectedId;
      const sibling = makeNode('', state.nodes[curId].parentId);
      const { nodes, rootIds } = insertSiblingAfter(state.nodes, state.rootIds, curId, sibling);
      return {
        ...state,
        nodes,
        rootIds,
        selectedId: sibling.id,
        editingId: sibling.id,
        draft: '',
        undoStack: pushUndo(state),
      };
    }

    case 'DELETE_NODE': {
      if (!state.selectedId || state.editingId) return state;
      const delId = state.selectedId;
      const delNode = state.nodes[delId];

      // Pick next selection: next sibling → prev sibling → parent → null
      const siblings = delNode.parentId
        ? state.nodes[delNode.parentId].childIds
        : state.rootIds;
      const idx = siblings.indexOf(delId);
      const nextSelected =
        siblings[idx + 1] ??
        siblings[idx - 1] ??
        delNode.parentId ??
        null;

      // Remove subtree from nodes map
      const toDelete = new Set(collectSubtree(state.nodes, delId));
      const newNodes: Record<NodeId, TreeNode> = {};
      for (const [k, v] of Object.entries(state.nodes)) {
        if (!toDelete.has(k)) newNodes[k] = v;
      }

      // Remove from parent's childIds or rootIds
      let newRootIds = state.rootIds;
      if (delNode.parentId) {
        newNodes[delNode.parentId] = {
          ...newNodes[delNode.parentId],
          childIds: newNodes[delNode.parentId].childIds.filter((c) => c !== delId),
        };
      } else {
        newRootIds = state.rootIds.filter((r) => r !== delId);
      }

      return {
        ...state,
        nodes: newNodes,
        rootIds: newRootIds,
        selectedId: nextSelected,
        editingId: null,
        undoStack: pushUndo(state),
      };
    }

    case 'UNDO': {
      if (!state.undoStack.length) return state;
      const prev = state.undoStack[state.undoStack.length - 1];
      return {
        ...prev,
        undoStack: state.undoStack.slice(0, -1),
      };
    }

    case 'NAVIGATE': {
      if (state.editingId || !state.selectedId) return state;
      const next = navigateNode(state.nodes, state.rootIds, state.selectedId, action.dir);
      return next ? { ...state, selectedId: next } : state;
    }

    default:
      return state;
  }
}

// ── Node Row ─────────────────────────────────────────────────────────────────

function NodeRow({
  id,
  state,
  dispatch,
  prefix,
  isLast,
  depth,
}: {
  id: NodeId;
  state: State;
  dispatch: React.Dispatch<Action>;
  prefix: string;
  isLast: boolean;
  depth: number;
}) {
  const node = state.nodes[id];
  const isSelected = state.selectedId === id;
  const isEditing = state.editingId === id;
  const displayText = isEditing ? state.draft : node.text;

  const connector = depth === 0 ? '' : isLast ? '└─ ' : '├─ ';
  const childPrefix = depth === 0 ? '' : isLast ? '   ' : '│  ';

  return (
    <>
      <div
        className="flex items-baseline leading-7 cursor-default select-none group"
        onClick={() => !state.editingId && dispatch({ type: 'SELECT', id })}
        onDoubleClick={() => dispatch({ type: 'START_EDIT', id })}
      >
        {(prefix + connector) && (
          <span className="text-gray-700 whitespace-pre font-mono text-sm shrink-0">
            {prefix + connector}
          </span>
        )}
        <span
          className={`font-mono text-sm px-1.5 py-0 rounded-sm transition-colors ${
            isSelected ? 'bg-gray-800' : 'group-hover:bg-gray-900'
          } ${isSelected ? 'text-white' : 'text-gray-500'}`}
        >
          {isEditing ? (
            <>
              {displayText}
              <span className="inline-block w-px h-[13px] bg-gray-300 ml-px align-middle animate-[blink_1s_step-end_infinite]" />
            </>
          ) : (
            displayText || <span className="text-gray-700">·</span>
          )}
        </span>
      </div>
      {node.childIds.map((childId, i) => (
        <NodeRow
          key={childId}
          id={childId}
          state={state}
          dispatch={dispatch}
          prefix={prefix + childPrefix}
          isLast={i === node.childIds.length - 1}
          depth={depth + 1}
        />
      ))}
    </>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function TreeEditor() {
  const [state, dispatch] = useReducer(reducer, INIT);
  const containerRef = useRef<HTMLDivElement>(null);

  const isEmpty = state.rootIds.length === 0;

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Tab') e.preventDefault();
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') e.preventDefault();

      // Cmd/Ctrl+Z — undo (any mode)
      if (e.key === 'z' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: 'UNDO' });
        return;
      }

      // Bootstrap: no nodes yet
      if (isEmpty) {
        if (e.key === 'Enter') dispatch({ type: 'CONFIRM_BOOTSTRAP' });
        else if (e.key === 'Backspace') dispatch({ type: 'BACKSPACE' });
        else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey)
          dispatch({ type: 'INPUT', char: e.key });
        return;
      }

      // Edit mode
      if (state.editingId) {
        if (e.key === 'Enter') dispatch({ type: 'CONFIRM_EDIT_CHILD' });
        else if (e.key === 'Tab') dispatch({ type: 'CONFIRM_EDIT_SIBLING' });
        else if (e.key === 'Escape') dispatch({ type: 'CONFIRM_EDIT' });
        else if (e.key === 'Backspace') dispatch({ type: 'BACKSPACE' });
        else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey)
          dispatch({ type: 'INPUT', char: e.key });
        return;
      }

      // Cmd/Ctrl+X — delete node (nav mode only)
      if (e.key === 'x' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        dispatch({ type: 'DELETE_NODE' });
        return;
      }

      // Navigate mode
      switch (e.key) {
        case 'Enter':
          if (state.selectedId) dispatch({ type: 'START_EDIT', id: state.selectedId });
          break;
        case 'Tab':
          dispatch({ type: 'QUICK_SIBLING' });
          break;
        case 'ArrowUp':
          dispatch({ type: 'NAVIGATE', dir: 'up' });
          break;
        case 'ArrowDown':
          dispatch({ type: 'NAVIGATE', dir: 'down' });
          break;
        case 'ArrowLeft':
          dispatch({ type: 'NAVIGATE', dir: 'left' });
          break;
        case 'ArrowRight':
          dispatch({ type: 'NAVIGATE', dir: 'right' });
          break;
      }
    },
    [state, isEmpty]
  );

  const mode = isEmpty ? null : state.editingId ? 'edit' : 'nav';

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="outline-none min-h-screen bg-black flex flex-col"
    >
      <div className="flex-1 p-10 pt-12">
        {isEmpty ? (
          <div className="font-mono text-sm text-white">
            {state.bootstrapText}
            <span className="inline-block w-px h-[13px] bg-white ml-px align-middle animate-[blink_1s_step-end_infinite]" />
          </div>
        ) : (
          <div>
            {state.rootIds.map((id, i) => (
              <NodeRow
                key={id}
                id={id}
                state={state}
                dispatch={dispatch}
                prefix=""
                isLast={i === state.rootIds.length - 1}
                depth={0}
              />
            ))}
          </div>
        )}
      </div>

      {/* Hint bar */}
      <div className="px-10 pb-6 flex gap-6 font-mono text-xs text-gray-700 select-none">
        {mode === null && (
          <span>type to begin · enter to confirm</span>
        )}
        {mode === 'nav' && (
          <>
            <span>enter <span className="text-gray-600">edit</span></span>
            <span>tab <span className="text-gray-600">sibling</span></span>
            <span>←↑↓→ <span className="text-gray-600">navigate</span></span>
            <span>⌘x <span className="text-gray-600">delete</span></span>
            <span>⌘z <span className="text-gray-600">undo</span></span>
          </>
        )}
        {mode === 'edit' && (
          <>
            <span>enter <span className="text-gray-600">child</span></span>
            <span>tab <span className="text-gray-600">sibling</span></span>
            <span>esc <span className="text-gray-600">done</span></span>
          </>
        )}
      </div>
    </div>
  );
}
