import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import {
  ChevronLeft,
  ChevronRight,
  CornerUpLeft,
  Gamepad2,
  Home,
  MapPinned,
  RotateCcw,
} from 'lucide-react';
import type {
  RepositoryChangedFile,
  RepositoryMapGraph,
  RepositoryMapGraphNode,
} from '../../../shared/types';
import {
  buildRepositoryGardenLayout,
  GARDEN_PAGE_SIZE,
  type GardenPath,
  type GardenPlot,
} from '../../utils/repository-garden-layout';

interface RepositoryGardenProps {
  graph: RepositoryMapGraph;
  changedFiles?: RepositoryChangedFile[];
  selectedNodeId?: string | null;
  compact?: boolean;
  onSelectNode: (nodeId: string) => void;
}

export function RepositoryGarden({
  graph,
  changedFiles = [],
  selectedNodeId,
  compact = false,
  onSelectNode,
}: RepositoryGardenProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rootNode = graph.nodes.find((node) => node.kind === 'repository') ?? graph.nodes[0];
  const [controlsActive, setControlsActive] = useState(false);
  const [scopeId, setScopeId] = useState(rootNode?.id ?? '');
  const [page, setPage] = useState(0);
  const [resetToken, setResetToken] = useState(0);
  const reducedMotion = useReducedMotion();
  const pageSize = compact ? 12 : GARDEN_PAGE_SIZE;
  const nodesById = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph.nodes],
  );
  const childCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of graph.nodes) {
      if (node.parentId) counts.set(node.parentId, (counts.get(node.parentId) ?? 0) + 1);
    }
    return counts;
  }, [graph.nodes]);
  const layout = useMemo(
    () =>
      buildRepositoryGardenLayout(graph, {
        scopeId,
        offset: page * pageSize,
        limit: pageSize,
      }),
    [graph, page, pageSize, scopeId],
  );
  const changedNodeIds = useMemo(
    () =>
      new Set(
        layout.plots
          .filter((plot) => changedFiles.some((file) => nodeContainsChange(plot.node, file)))
          .map((plot) => plot.node.id),
      ),
    [changedFiles, layout.plots],
  );
  const breadcrumbs = useMemo(
    () => buildBreadcrumbs(layout.scopeNode, nodesById),
    [layout.scopeNode, nodesById],
  );
  const selectedNode = selectedNodeId ? nodesById.get(selectedNodeId) : undefined;
  const pageCount = Math.max(1, Math.ceil(layout.totalChildren / pageSize));

  useEffect(() => {
    if (!rootNode || nodesById.has(scopeId)) return;
    setScopeId(rootNode.id);
    setPage(0);
  }, [nodesById, rootNode, scopeId]);

  const resetScene = useCallback(() => setResetToken((token) => token + 1), []);
  const openScope = useCallback(
    (nodeId: string) => {
      if (!childCounts.get(nodeId)) {
        onSelectNode(nodeId);
        return;
      }
      setScopeId(nodeId);
      setPage(0);
      onSelectNode('');
      resetScene();
    },
    [childCounts, onSelectNode, resetScene],
  );
  const goToScope = useCallback(
    (nodeId: string) => {
      setScopeId(nodeId);
      setPage(0);
      onSelectNode('');
      resetScene();
    },
    [onSelectNode, resetScene],
  );
  const goBack = useCallback(() => {
    if (layout.scopeNode.parentId) goToScope(layout.scopeNode.parentId);
  }, [goToScope, layout.scopeNode.parentId]);
  const changePage = useCallback(
    (nextPage: number) => {
      setPage(nextPage);
      onSelectNode('');
      resetScene();
    },
    [onSelectNode, resetScene],
  );

  if (!rootNode) return null;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onFocus={() => setControlsActive(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setControlsActive(false);
      }}
      onPointerDown={() => containerRef.current?.focus()}
      className="relative min-w-0 overflow-hidden bg-[#08140f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      style={{ height: compact ? 400 : 560 }}
      aria-label={`Archive Garden ${layout.scopeNode.kind} view for ${layout.scopeNode.name}. Focus this area and use WASD or arrow keys to walk.`}
    >
      <Canvas
        key={`${scopeId}:${page}:${resetToken}`}
        orthographic
        shadows={!reducedMotion}
        dpr={[1, 1.5]}
        camera={{ position: [12, 15, 12], zoom: compact ? 29 : 35, near: 0.1, far: 180 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        performance={{ min: 0.55 }}
        onPointerMissed={() => onSelectNode('')}
      >
        <color attach="background" args={['#08140f']} />
        <fog attach="fog" args={['#08140f', 30, 82]} />
        <ambientLight intensity={1.2} color="#a9c3b5" />
        <hemisphereLight args={['#9ec7d7', '#101711', 1.05]} />
        <directionalLight
          castShadow={!reducedMotion}
          position={[12, 18, 8]}
          intensity={2.15}
          color="#ffe0ad"
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
        />
        <GardenWorld
          layout={layout}
          active={controlsActive}
          reducedMotion={reducedMotion}
          selectedNodeId={selectedNodeId}
          changedNodeIds={changedNodeIds}
          childCounts={childCounts}
          onSelectNode={onSelectNode}
          onEnterNode={openScope}
          onBack={goBack}
        />
      </Canvas>

      <div className="absolute left-3 top-3 max-w-[calc(100%-7rem)] rounded-lg bg-bg-primary/95 px-3 py-2 shadow-md">
        <div className="flex items-center gap-2 text-xs font-medium text-text-primary">
          <MapPinned size={14} className="text-success" />
          <span>{layout.scopeNode.kind === 'repository' ? 'Archive Garden' : nodeDistrictName(layout.scopeNode)}</span>
          <span className="text-text-muted">·</span>
          <span className="capitalize text-text-tertiary">{layout.scopeNode.kind}</span>
        </div>
        <nav aria-label="Garden breadcrumb" className="mt-1.5 flex min-w-0 items-center gap-1">
          {breadcrumbs.map((node, index) => (
            <span key={node.id} className="flex min-w-0 items-center gap-1">
              {index > 0 && <ChevronRight size={11} className="shrink-0 text-text-muted" />}
              <button
                type="button"
                onClick={() => goToScope(node.id)}
                className={`truncate font-mono text-xs ${
                  index === breadcrumbs.length - 1
                    ? 'text-text-primary'
                    : 'text-text-tertiary hover:text-text-primary'
                }`}
              >
                {node.kind === 'repository' ? graph.repositoryName : node.name}
              </button>
            </span>
          ))}
        </nav>
        <p className="mt-1 max-w-[64ch] truncate text-xs text-text-tertiary">
          {selectedNode ? nodeSummary(selectedNode) : scopeSummary(layout.scopeNode, layout.totalChildren)}
        </p>
      </div>

      <div className="absolute right-3 top-3 flex items-center gap-1.5">
        {layout.scopeNode.parentId && (
          <button
            type="button"
            onClick={goBack}
            className="grid h-9 w-9 place-items-center rounded-lg bg-bg-primary/95 text-text-secondary shadow-md hover:bg-bg-tertiary hover:text-text-primary"
            title="Go up one garden district"
            aria-label="Go up one garden district"
          >
            <CornerUpLeft size={15} />
          </button>
        )}
        {layout.scopeNode.id !== rootNode.id && (
          <button
            type="button"
            onClick={() => goToScope(rootNode.id)}
            className="grid h-9 w-9 place-items-center rounded-lg bg-bg-primary/95 text-text-secondary shadow-md hover:bg-bg-tertiary hover:text-text-primary"
            title="Return to repository entrance"
            aria-label="Return to repository entrance"
          >
            <Home size={15} />
          </button>
        )}
        <button
          type="button"
          onClick={resetScene}
          className="grid h-9 w-9 place-items-center rounded-lg bg-bg-primary/95 text-text-secondary shadow-md hover:bg-bg-tertiary hover:text-text-primary"
          title="Return to this district's entrance"
          aria-label="Return to this district's entrance"
        >
          <RotateCcw size={15} />
        </button>
      </div>

      <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-2 rounded-lg bg-bg-primary/95 px-3 py-2 text-xs text-text-secondary shadow-md">
        <Gamepad2 size={14} className={controlsActive ? 'text-accent' : 'text-text-muted'} />
        <span>
          {controlsActive
            ? 'WASD / arrows to walk · E to enter or inspect · Esc to go back'
            : 'Click the garden to walk'}
        </span>
      </div>

      {pageCount > 1 && (
        <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg bg-bg-primary/95 p-1 shadow-md">
          <button
            type="button"
            onClick={() => changePage(page - 1)}
            disabled={page === 0}
            className="grid h-7 w-7 place-items-center rounded-md text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-35"
            aria-label="Previous garden page"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="px-1.5 font-mono text-xs text-text-tertiary">
            {page + 1}/{pageCount}
          </span>
          <button
            type="button"
            onClick={() => changePage(page + 1)}
            disabled={page >= pageCount - 1}
            className="grid h-7 w-7 place-items-center rounded-md text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-35"
            aria-label="Next garden page"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function GardenWorld({
  layout,
  active,
  reducedMotion,
  selectedNodeId,
  changedNodeIds,
  childCounts,
  onSelectNode,
  onEnterNode,
  onBack,
}: {
  layout: ReturnType<typeof buildRepositoryGardenLayout>;
  active: boolean;
  reducedMotion: boolean;
  selectedNodeId?: string | null;
  changedNodeIds: Set<string>;
  childCounts: Map<string, number>;
  onSelectNode: (nodeId: string) => void;
  onEnterNode: (nodeId: string) => void;
  onBack: () => void;
}) {
  return (
    <>
      <GardenGround extent={layout.extent} scopeKind={layout.scopeNode.kind} />
      {layout.plots.map((plot) => (
        <WalkingPath key={`walk:${plot.node.id}`} plot={plot} />
      ))}
      {layout.paths.map((gardenPath) => (
        <DependencyPath
          key={gardenPath.id}
          path={gardenPath}
          highlighted={
            gardenPath.sourceId === selectedNodeId || gardenPath.targetId === selectedNodeId
          }
        />
      ))}
      {layout.plots.map((plot) => (
        <ArchivePlot
          key={plot.node.id}
          plot={plot}
          selected={plot.node.id === selectedNodeId}
          changed={changedNodeIds.has(plot.node.id)}
          hasChildren={Boolean(childCounts.get(plot.node.id))}
          onSelect={onSelectNode}
          onEnter={onEnterNode}
        />
      ))}
      <GardenAvatar
        active={active}
        reducedMotion={reducedMotion}
        spawn={layout.spawn}
        extent={layout.extent}
        plots={layout.plots}
        onInteract={onEnterNode}
        onBack={onBack}
      />
    </>
  );
}

function GardenGround({
  extent,
  scopeKind,
}: {
  extent: number;
  scopeKind: RepositoryMapGraphNode['kind'];
}) {
  const innerColor =
    scopeKind === 'file'
      ? '#17242b'
      : scopeKind === 'directory'
        ? '#192a20'
        : scopeKind === 'module'
          ? '#183021'
          : '#1a3020';
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[extent * 2, extent * 2]} />
        <meshStandardMaterial color="#101b15" roughness={0.98} />
      </mesh>
      <mesh position={[0, 0.035, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[extent * 1.84, extent * 1.84]} />
        <meshStandardMaterial color={innerColor} roughness={1} />
      </mesh>
      <mesh position={[0, 0.1, 0]} receiveShadow>
        <boxGeometry args={[2.3, 0.16, 2.3]} />
        <meshStandardMaterial color="#536057" roughness={0.95} />
      </mesh>
      <GardenPlant x={-1.8} z={0} seed={11} />
      <GardenPlant x={1.8} z={0} seed={17} />
    </group>
  );
}

function WalkingPath({ plot }: { plot: GardenPlot }) {
  const length = Math.hypot(plot.x, plot.z);
  if (length < 0.1) return null;
  const angle = Math.atan2(plot.z, plot.x);
  return (
    <mesh position={[plot.x / 2, 0.11, plot.z / 2]} rotation={[0, -angle, 0]} receiveShadow>
      <boxGeometry args={[length, 0.12, 1.05]} />
      <meshStandardMaterial color="#4a574f" roughness={0.96} />
    </mesh>
  );
}

function DependencyPath({ path, highlighted }: { path: GardenPath; highlighted: boolean }) {
  const [sourceX, sourceZ] = path.source;
  const [targetX, targetZ] = path.target;
  const dx = targetX - sourceX;
  const dz = targetZ - sourceZ;
  const length = Math.hypot(dx, dz);
  const angle = Math.atan2(dz, dx);
  const markerX = sourceX + dx * 0.72;
  const markerZ = sourceZ + dz * 0.72;
  return (
    <group>
      <mesh
        position={[(sourceX + targetX) / 2, 0.22, (sourceZ + targetZ) / 2]}
        rotation={[0, -angle, 0]}
        receiveShadow
      >
        <boxGeometry args={[length, 0.12, highlighted ? 0.62 : 0.38]} />
        <meshStandardMaterial
          color={highlighted ? '#5ec8ff' : '#496a72'}
          emissive={highlighted ? '#183b4b' : '#10262b'}
          roughness={0.78}
        />
      </mesh>
      <mesh position={[markerX, 0.34, markerZ]} rotation={[0, -angle, 0]}>
        <boxGeometry args={[0.52, 0.18, 0.78]} />
        <meshStandardMaterial color={highlighted ? '#a9e5ff' : '#71979c'} />
      </mesh>
    </group>
  );
}

function ArchivePlot({
  plot,
  selected,
  changed,
  hasChildren,
  onSelect,
  onEnter,
}: {
  plot: GardenPlot;
  selected: boolean;
  changed: boolean;
  hasChildren: boolean;
  onSelect: (nodeId: string) => void;
  onEnter: (nodeId: string) => void;
}) {
  const stopAnd = (callback: () => void) => (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    callback();
  };
  return (
    <group
      position={[plot.x, 0, plot.z]}
      onClick={stopAnd(() => onSelect(plot.node.id))}
      onDoubleClick={stopAnd(() => onEnter(plot.node.id))}
    >
      {plot.node.kind === 'module' ? (
        <ModulePavilion plot={plot} selected={selected} changed={changed} />
      ) : plot.node.kind === 'directory' ? (
        <DirectoryCourtyard plot={plot} selected={selected} changed={changed} />
      ) : plot.node.kind === 'file' ? (
        <FileWorkbench plot={plot} selected={selected} changed={changed} />
      ) : (
        <SymbolExhibit plot={plot} selected={selected} changed={changed} />
      )}
      <ArchiveSign plot={plot} selected={selected} changed={changed} hasChildren={hasChildren} />
    </group>
  );
}

function ModulePavilion({
  plot,
  selected,
  changed,
}: {
  plot: GardenPlot;
  selected: boolean;
  changed: boolean;
}) {
  const stone = plot.seed % 2 === 0 ? '#273746' : '#303b43';
  const roof = changed ? '#c9672b' : selected ? '#bd642f' : '#17232c';
  const windowCount = Math.max(3, Math.min(6, Math.round(plot.width)));
  return (
    <group>
      <mesh position={[0, 0.14, 0]} receiveShadow>
        <boxGeometry args={[plot.width + 1.5, 0.24, plot.depth + 1.5]} />
        <meshStandardMaterial color={selected ? '#ff8a3d' : '#5b665f'} roughness={0.95} />
      </mesh>
      <mesh position={[0, plot.height / 2 + 0.25, 0]} castShadow receiveShadow>
        <boxGeometry args={[plot.width, plot.height, plot.depth]} />
        <meshStandardMaterial color={stone} roughness={0.88} />
      </mesh>
      <mesh position={[0, plot.height + 0.42, 0]} castShadow>
        <boxGeometry args={[plot.width + 0.5, 0.42, plot.depth + 0.5]} />
        <meshStandardMaterial color={roof} roughness={0.72} />
      </mesh>
      <mesh position={[0, 0.78, plot.depth / 2 + 0.035]}>
        <boxGeometry args={[0.95, 1.28, 0.12]} />
        <meshStandardMaterial color="#8e5836" roughness={0.82} />
      </mesh>
      {Array.from({ length: windowCount }, (_, index) => {
        const x = ((index + 1) / (windowCount + 1) - 0.5) * (plot.width - 0.5);
        return (
          <mesh key={index} position={[x, plot.height * 0.58, plot.depth / 2 + 0.07]}>
            <boxGeometry args={[0.42, 0.58, 0.08]} />
            <meshStandardMaterial color="#ffd49a" emissive="#8a4b1f" emissiveIntensity={0.7} />
          </mesh>
        );
      })}
      <GardenPlant x={-plot.width / 2 - 0.65} z={plot.depth / 2 + 0.55} seed={plot.seed} />
      <GardenPlant x={plot.width / 2 + 0.7} z={-plot.depth / 2 - 0.45} seed={plot.seed >>> 2} />
      {changed && <ChangeScaffold plot={plot} />}
    </group>
  );
}

function DirectoryCourtyard({
  plot,
  selected,
  changed,
}: {
  plot: GardenPlot;
  selected: boolean;
  changed: boolean;
}) {
  const wallColor = changed ? '#9a552e' : selected ? '#c46b36' : '#52665b';
  return (
    <group>
      <mesh position={[0, 0.1, 0]} receiveShadow>
        <boxGeometry args={[plot.width + 1, 0.18, plot.depth + 1]} />
        <meshStandardMaterial color={selected ? '#805234' : '#46534b'} roughness={0.96} />
      </mesh>
      <mesh position={[0, 0.7, -plot.depth / 2]} castShadow>
        <boxGeometry args={[plot.width, 1.25, 0.42]} />
        <meshStandardMaterial color={wallColor} roughness={0.94} />
      </mesh>
      <mesh position={[-plot.width / 2, 0.7, 0]} castShadow>
        <boxGeometry args={[0.42, 1.25, plot.depth]} />
        <meshStandardMaterial color={wallColor} roughness={0.94} />
      </mesh>
      <mesh position={[plot.width / 2, 0.7, 0]} castShadow>
        <boxGeometry args={[0.42, 1.25, plot.depth]} />
        <meshStandardMaterial color={wallColor} roughness={0.94} />
      </mesh>
      <mesh position={[-plot.width * 0.32, 0.7, plot.depth / 2]} castShadow>
        <boxGeometry args={[plot.width * 0.36, 1.25, 0.42]} />
        <meshStandardMaterial color={wallColor} roughness={0.94} />
      </mesh>
      <mesh position={[plot.width * 0.32, 0.7, plot.depth / 2]} castShadow>
        <boxGeometry args={[plot.width * 0.36, 1.25, 0.42]} />
        <meshStandardMaterial color={wallColor} roughness={0.94} />
      </mesh>
      <GardenPlant x={0} z={-0.2} seed={plot.seed} />
      <mesh position={[0, 0.38, 1.05]} castShadow>
        <boxGeometry args={[1.25, 0.55, 0.55]} />
        <meshStandardMaterial color="#8a6847" roughness={0.9} />
      </mesh>
      {changed && <ChangeBeacon height={2.5} />}
    </group>
  );
}

function FileWorkbench({
  plot,
  selected,
  changed,
}: {
  plot: GardenPlot;
  selected: boolean;
  changed: boolean;
}) {
  const spineCount = Math.max(2, Math.min(7, plot.node.symbolCount ?? 3));
  return (
    <group>
      <mesh position={[0, 0.1, 0]} receiveShadow>
        <boxGeometry args={[plot.width + 0.8, 0.16, plot.depth + 0.8]} />
        <meshStandardMaterial color={selected ? '#8b5a37' : '#46514c'} roughness={0.96} />
      </mesh>
      <mesh position={[0, 0.82, 0]} castShadow>
        <boxGeometry args={[plot.width, 0.28, plot.depth]} />
        <meshStandardMaterial color={changed ? '#9a5c36' : '#76573f'} roughness={0.82} />
      </mesh>
      <mesh position={[-plot.width * 0.35, 0.42, 0]} castShadow>
        <boxGeometry args={[0.24, 0.7, plot.depth * 0.78]} />
        <meshStandardMaterial color="#4b382d" />
      </mesh>
      <mesh position={[plot.width * 0.35, 0.42, 0]} castShadow>
        <boxGeometry args={[0.24, 0.7, plot.depth * 0.78]} />
        <meshStandardMaterial color="#4b382d" />
      </mesh>
      <mesh position={[-0.45, 1.03, 0]} rotation={[-0.08, 0.15, 0]}>
        <boxGeometry args={[1.2, 0.08, 1.25]} />
        <meshStandardMaterial color="#d9d1b8" emissive="#4d493e" emissiveIntensity={0.25} />
      </mesh>
      {Array.from({ length: spineCount }, (_, index) => (
        <mesh
          key={index}
          position={[0.45 + index * 0.18 - spineCount * 0.09, 1.18, -0.62]}
          castShadow
        >
          <boxGeometry args={[0.12, 0.52 + (index % 3) * 0.1, 0.32]} />
          <meshStandardMaterial color={index % 2 ? '#5ec8ff' : '#ff8a3d'} roughness={0.7} />
        </mesh>
      ))}
      <ChangeBeacon height={changed ? 2.25 : 1.85} active={changed} />
    </group>
  );
}

function SymbolExhibit({
  plot,
  selected,
  changed,
}: {
  plot: GardenPlot;
  selected: boolean;
  changed: boolean;
}) {
  const color = changed ? '#ff8a3d' : selected ? '#ffd166' : '#5ec8ff';
  return (
    <group>
      <mesh position={[0, 0.12, 0]} receiveShadow>
        <boxGeometry args={[plot.width + 0.65, 0.2, plot.depth + 0.65]} />
        <meshStandardMaterial color={selected ? '#74513d' : '#44514e'} roughness={0.94} />
      </mesh>
      <mesh position={[0, 0.68, 0]} castShadow>
        <boxGeometry args={[1.35, 1.05, 1.35]} />
        <meshStandardMaterial color="#36434c" roughness={0.84} />
      </mesh>
      <SymbolSculpture kind={plot.node.symbolKind} color={color} />
      {plot.node.exported && (
        <mesh position={[0.82, 1.25, 0]} castShadow>
          <boxGeometry args={[0.18, 1.2, 0.18]} />
          <meshStandardMaterial color="#d9d1b8" emissive="#615f54" emissiveIntensity={0.25} />
        </mesh>
      )}
    </group>
  );
}

function SymbolSculpture({
  kind,
  color,
}: {
  kind?: RepositoryMapGraphNode['symbolKind'];
  color: string;
}) {
  if (kind === 'function' || kind === 'method') {
    return (
      <group position={[0, 1.65, 0]}>
        <mesh position={[-0.42, 0, 0]} castShadow>
          <boxGeometry args={[0.22, 1.15, 0.35]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.22} />
        </mesh>
        <mesh position={[0.42, 0, 0]} castShadow>
          <boxGeometry args={[0.22, 1.15, 0.35]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.22} />
        </mesh>
        <mesh position={[0, 0.45, 0]} castShadow>
          <boxGeometry args={[0.7, 0.22, 0.35]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.22} />
        </mesh>
      </group>
    );
  }
  return (
    <group position={[0, 1.55, 0]}>
      <mesh castShadow>
        <boxGeometry args={[0.82, 0.82, 0.82]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.2} />
      </mesh>
      <mesh position={[0, 0.68, 0]} castShadow>
        <boxGeometry args={[0.48, 0.48, 0.48]} />
        <meshStandardMaterial color="#d8e5ea" emissive="#566b73" emissiveIntensity={0.25} />
      </mesh>
    </group>
  );
}

function ChangeScaffold({ plot }: { plot: GardenPlot }) {
  return (
    <group position={[-plot.width / 2 - 0.25, plot.height * 0.54, 0]}>
      <mesh>
        <boxGeometry args={[0.12, plot.height * 0.95, plot.depth + 0.7]} />
        <meshStandardMaterial color="#e37a35" />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <boxGeometry args={[0.12, plot.depth + 0.7, plot.height * 0.72]} />
        <meshStandardMaterial color="#e37a35" />
      </mesh>
    </group>
  );
}

function ChangeBeacon({ height, active = true }: { height: number; active?: boolean }) {
  return (
    <group position={[1.15, 0, 0.75]}>
      <mesh position={[0, height / 2, 0]} castShadow>
        <boxGeometry args={[0.15, height, 0.15]} />
        <meshStandardMaterial color={active ? '#ff8a3d' : '#63746b'} />
      </mesh>
      <mesh position={[0, height + 0.12, 0]} castShadow>
        <boxGeometry args={[0.5, 0.32, 0.5]} />
        <meshStandardMaterial
          color={active ? '#ffd166' : '#7d9085'}
          emissive={active ? '#9b4b18' : '#26342d'}
          emissiveIntensity={0.55}
        />
      </mesh>
    </group>
  );
}

function ArchiveSign({
  plot,
  selected,
  changed,
  hasChildren,
}: {
  plot: GardenPlot;
  selected: boolean;
  changed: boolean;
  hasChildren: boolean;
}) {
  const texture = useMemo(
    () => createSignTexture(plot.node, { selected, changed, hasChildren }),
    [changed, hasChildren, plot.node, selected],
  );
  useEffect(() => () => texture.dispose(), [texture]);
  const width = plot.node.kind === 'module' ? 7.6 : 6.2;
  return (
    <sprite position={[0, plot.height + 2.25, 0]} scale={[width, 2.05, 1]} renderOrder={20}>
      <spriteMaterial map={texture} transparent depthTest={false} toneMapped={false} />
    </sprite>
  );
}

function createSignTexture(
  node: RepositoryMapGraphNode,
  state: { selected: boolean; changed: boolean; hasChildren: boolean },
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 208;
  const context = canvas.getContext('2d');
  if (!context) return new THREE.CanvasTexture(canvas);
  context.clearRect(0, 0, canvas.width, canvas.height);
  roundedRect(context, 8, 8, 752, 192, 24);
  context.fillStyle = state.selected ? '#172033' : '#0b1020';
  context.fill();
  context.lineWidth = state.selected ? 7 : 4;
  context.strokeStyle = state.changed ? '#ff8a3d' : state.selected ? '#ffd166' : '#52627c';
  context.stroke();

  context.fillStyle = '#f8fbff';
  context.font = '600 34px IBM Plex Sans, system-ui, sans-serif';
  context.fillText(fitCanvasText(context, node.name, 590), 32, 52);

  context.fillStyle = '#cbd6e6';
  context.font = '400 24px IBM Plex Sans, system-ui, sans-serif';
  const summaryLines = wrapCanvasText(context, nodeSummary(node), 704, 2);
  summaryLines.forEach((line, index) => context.fillText(line, 32, 96 + index * 32));

  context.fillStyle = state.hasChildren ? '#ffb37d' : '#95a3b8';
  context.font = '500 20px IBM Plex Mono, ui-monospace, monospace';
  const action = state.hasChildren ? 'E / DOUBLE-CLICK TO ENTER' : 'E TO INSPECT';
  context.fillText(action, 32, 184);
  if (state.changed) {
    context.textAlign = 'right';
    context.fillStyle = '#ffd166';
    context.fillText('CHANGED', 736, 52);
    context.textAlign = 'left';
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function fitCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (context.measureText(text).width <= maxWidth) return text;
  let value = text;
  while (value.length > 1 && context.measureText(`${value}…`).width > maxWidth) {
    value = value.slice(0, -1);
  }
  return `${value}…`;
}

function wrapCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (context.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    if (lines.length === maxLines - 1) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (words.join(' ').length > lines.join(' ').length && lines.length > 0) {
    lines[lines.length - 1] = fitCanvasText(context, `${lines[lines.length - 1]}…`, maxWidth);
  }
  return lines;
}

function GardenPlant({ x, z, seed }: { x: number; z: number; seed: number }) {
  const height = 0.55 + (seed % 4) * 0.1;
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, height / 2, 0]} castShadow>
        <boxGeometry args={[0.18, height, 0.18]} />
        <meshStandardMaterial color="#5a3b29" />
      </mesh>
      <mesh position={[0, height + 0.3, 0]} castShadow>
        <boxGeometry args={[0.86, 0.7, 0.86]} />
        <meshStandardMaterial color={seed % 2 ? '#3f7146' : '#4c8250'} roughness={0.95} />
      </mesh>
    </group>
  );
}

function GardenAvatar({
  active,
  reducedMotion,
  spawn,
  extent,
  plots,
  onInteract,
  onBack,
}: {
  active: boolean;
  reducedMotion: boolean;
  spawn: [number, number];
  extent: number;
  plots: GardenPlot[];
  onInteract: (nodeId: string) => void;
  onBack: () => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const keysRef = useRef(new Set<string>());
  const positionRef = useRef(new THREE.Vector3(spawn[0], 0, spawn[1]));
  const cameraTarget = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!active || isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
        event.preventDefault();
        keysRef.current.add(key);
      }
      if (key === 'e' || key === 'enter') {
        event.preventDefault();
        const nearest = nearestPlot(positionRef.current, plots);
        if (nearest && nearest.distance < 5.4) onInteract(nearest.plot.node.id);
      }
      if (key === 'escape' || key === 'backspace') {
        event.preventDefault();
        onBack();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => keysRef.current.delete(event.key.toLowerCase());
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [active, onBack, onInteract, plots]);

  useFrame(({ camera }, delta) => {
    if (active) {
      const keys = keysRef.current;
      const direction = new THREE.Vector3(
        Number(keys.has('d') || keys.has('arrowright')) -
          Number(keys.has('a') || keys.has('arrowleft')),
        0,
        Number(keys.has('s') || keys.has('arrowdown')) -
          Number(keys.has('w') || keys.has('arrowup')),
      );
      if (direction.lengthSq() > 0) {
        direction.normalize().multiplyScalar(Math.min(delta, 0.05) * 5.2);
        const candidate = positionRef.current.clone().add(direction);
        candidate.x = THREE.MathUtils.clamp(candidate.x, -extent + 1, extent - 1);
        candidate.z = THREE.MathUtils.clamp(candidate.z, -extent + 1, extent - 1);
        if (!collidesWithPlot(candidate, plots)) positionRef.current.copy(candidate);
      }
    }

    if (groupRef.current) {
      groupRef.current.position.copy(positionRef.current);
      groupRef.current.children[0].rotation.y += reducedMotion ? 0 : delta * 0.45;
    }
    cameraTarget.set(positionRef.current.x + 12, 15, positionRef.current.z + 12);
    if (reducedMotion) camera.position.copy(cameraTarget);
    else camera.position.lerp(cameraTarget, Math.min(1, delta * 5));
    camera.lookAt(positionRef.current.x, 0, positionRef.current.z);
  });

  return (
    <group ref={groupRef} position={[spawn[0], 0, spawn[1]]}>
      <mesh position={[0, 0.92, 0]} castShadow>
        <boxGeometry args={[0.62, 0.88, 0.5]} />
        <meshStandardMaterial color="#e27b36" roughness={0.72} />
      </mesh>
      <mesh position={[0, 1.58, 0]} castShadow>
        <boxGeometry args={[0.52, 0.48, 0.48]} />
        <meshStandardMaterial color="#d7c1a3" roughness={0.8} />
      </mesh>
      <mesh position={[-0.2, 0.31, 0]} castShadow>
        <boxGeometry args={[0.18, 0.55, 0.22]} />
        <meshStandardMaterial color="#26374b" />
      </mesh>
      <mesh position={[0.2, 0.31, 0]} castShadow>
        <boxGeometry args={[0.18, 0.55, 0.22]} />
        <meshStandardMaterial color="#26374b" />
      </mesh>
    </group>
  );
}

function nearestPlot(position: THREE.Vector3, plots: GardenPlot[]) {
  return plots
    .map((plot) => ({ plot, distance: Math.hypot(position.x - plot.x, position.z - plot.z) }))
    .toSorted((a, b) => a.distance - b.distance)[0];
}

function collidesWithPlot(position: THREE.Vector3, plots: GardenPlot[]): boolean {
  return plots.some(
    (plot) =>
      Math.abs(position.x - plot.x) < plot.width / 2 + 0.5 &&
      Math.abs(position.z - plot.z) < plot.depth / 2 + 0.5,
  );
}

function nodeContainsChange(node: RepositoryMapGraphNode, file: RepositoryChangedFile): boolean {
  const filePath = normalizePath(file.filePath);
  if (node.kind === 'module' || node.kind === 'directory') {
    return node.path === '.' || filePath === node.path || filePath.startsWith(`${node.path}/`);
  }
  if (node.kind === 'file') return filePath === node.path;
  if (node.kind !== 'symbol' || filePath !== node.path || !node.sourceRange) return false;
  const currentRanges = file.ranges?.filter((range) => range.side === 'current') ?? [];
  return (
    currentRanges.length === 0 ||
    currentRanges.some(
      (range) =>
        range.startLine <= node.sourceRange!.endLine &&
        range.endLine >= node.sourceRange!.startLine,
    )
  );
}

function buildBreadcrumbs(
  node: RepositoryMapGraphNode,
  nodesById: Map<string, RepositoryMapGraphNode>,
): RepositoryMapGraphNode[] {
  const breadcrumbs = [node];
  let current = node;
  while (current.parentId) {
    const parent = nodesById.get(current.parentId);
    if (!parent) break;
    breadcrumbs.unshift(parent);
    current = parent;
  }
  return breadcrumbs;
}

function nodeDistrictName(node: RepositoryMapGraphNode): string {
  if (node.kind === 'module') return `${node.name} district`;
  if (node.kind === 'directory') return `${node.name} courtyard`;
  if (node.kind === 'file') return `${node.name} workbench`;
  return node.name;
}

function scopeSummary(node: RepositoryMapGraphNode, childCount: number): string {
  if (node.purpose) return node.purpose;
  const childLabel = childCount === 1 ? 'area' : 'areas';
  return `${childCount} indexed ${childLabel} · Enter a labelled structure to explore deeper`;
}

function nodeSummary(node: RepositoryMapGraphNode): string {
  if (node.purpose) return node.purpose;
  if (node.kind === 'module') return `${node.fileCount ?? 0} indexed files`;
  if (node.kind === 'directory') return `Folder courtyard · ${node.path}`;
  if (node.kind === 'file') {
    const symbols = node.symbolCount;
    return symbols === undefined
      ? `${node.language ?? 'Source'} file`
      : `${symbols} indexed ${symbols === 1 ? 'symbol' : 'symbols'} · ${node.path}`;
  }
  if (node.kind === 'symbol') {
    const range = node.sourceRange
      ? ` · lines ${node.sourceRange.startLine}–${node.sourceRange.endLine}`
      : '';
    return `${node.exported ? 'Exported' : 'File-local'} ${node.symbolKind ?? 'symbol'}${range}`;
  }
  return 'Repository entrance';
}

function normalizePath(value: string): string {
  return value.replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/$/, '');
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
