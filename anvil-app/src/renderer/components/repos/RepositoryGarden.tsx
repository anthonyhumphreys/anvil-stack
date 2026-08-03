import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { Gamepad2, MapPinned, RotateCcw } from 'lucide-react';
import type {
  RepositoryChangedFile,
  RepositoryMapGraph,
} from '../../../shared/types';
import {
  buildRepositoryGardenLayout,
  type GardenPath,
  type GardenPlot,
} from '../../utils/repository-garden-layout';

interface RepositoryGardenProps {
  graph: RepositoryMapGraph;
  changedFiles?: RepositoryChangedFile[];
  selectedNodeId?: string | null;
  compact?: boolean;
  onSelectNode: (nodeId: string) => void;
  onOpenNode: (nodeId: string) => void;
}

export function RepositoryGarden({
  graph,
  changedFiles = [],
  selectedNodeId,
  compact = false,
  onSelectNode,
  onOpenNode,
}: RepositoryGardenProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [controlsActive, setControlsActive] = useState(false);
  const [resetToken, setResetToken] = useState(0);
  const reducedMotion = useReducedMotion();
  const layout = useMemo(() => buildRepositoryGardenLayout(graph), [graph]);
  const changedModules = useMemo(
    () =>
      new Set(
        layout.plots
          .filter((plot) => changedFiles.some((file) => belongsToModule(plot.node.path, file.filePath)))
          .map((plot) => plot.node.id),
      ),
    [changedFiles, layout.plots],
  );
  const selectedModule = layout.plots.find((plot) => plot.node.id === selectedNodeId)?.node;

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
      aria-label="Archive Garden repository view. Focus this area and use WASD or arrow keys to walk."
    >
      <Canvas
        key={resetToken}
        orthographic
        shadows={!reducedMotion}
        dpr={[1, 1.5]}
        camera={{ position: [12, 15, 12], zoom: compact ? 31 : 37, near: 0.1, far: 160 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        onPointerMissed={() => onSelectNode('')}
      >
        <color attach="background" args={['#08140f']} />
        <fog attach="fog" args={['#08140f', 26, 70]} />
        <ambientLight intensity={1.25} color="#a9c3b5" />
        <hemisphereLight args={['#9ec7d7', '#101711', 1.1]} />
        <directionalLight
          castShadow={!reducedMotion}
          position={[12, 18, 8]}
          intensity={2.2}
          color="#ffe0ad"
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
        />
        <GardenWorld
          layout={layout}
          active={controlsActive}
          reducedMotion={reducedMotion}
          selectedNodeId={selectedNodeId}
          changedModules={changedModules}
          onSelectNode={onSelectNode}
          onOpenNode={onOpenNode}
        />
      </Canvas>

      <div className="pointer-events-none absolute left-3 top-3 max-w-[calc(100%-6rem)] rounded-lg bg-bg-primary/92 px-3 py-2 shadow-md">
        <div className="flex items-center gap-2 text-xs font-medium text-text-primary">
          <MapPinned size={14} className="text-success" /> Archive Garden
        </div>
        <p className="mt-0.5 truncate text-xs text-text-tertiary">
          {selectedModule ? selectedModule.path : 'Walk to a pavilion and press E to inspect it'}
        </p>
      </div>

      <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-2 rounded-lg bg-bg-primary/92 px-3 py-2 text-xs text-text-secondary shadow-md">
        <Gamepad2 size={14} className={controlsActive ? 'text-accent' : 'text-text-muted'} />
        <span>{controlsActive ? 'WASD / arrows to walk · E to inspect' : 'Click the garden to walk'}</span>
      </div>

      <button
        type="button"
        onClick={() => setResetToken((token) => token + 1)}
        className="absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-lg bg-bg-primary/92 text-text-secondary shadow-md hover:bg-bg-tertiary hover:text-text-primary"
        title="Return to the garden entrance"
        aria-label="Return to the garden entrance"
      >
        <RotateCcw size={15} />
      </button>
    </div>
  );
}

function GardenWorld({
  layout,
  active,
  reducedMotion,
  selectedNodeId,
  changedModules,
  onSelectNode,
  onOpenNode,
}: {
  layout: ReturnType<typeof buildRepositoryGardenLayout>;
  active: boolean;
  reducedMotion: boolean;
  selectedNodeId?: string | null;
  changedModules: Set<string>;
  onSelectNode: (nodeId: string) => void;
  onOpenNode: (nodeId: string) => void;
}) {
  return (
    <>
      <GardenGround extent={layout.extent} />
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
        <ModulePavilion
          key={plot.node.id}
          plot={plot}
          selected={plot.node.id === selectedNodeId}
          changed={changedModules.has(plot.node.id)}
          onSelect={onSelectNode}
          onOpen={onOpenNode}
        />
      ))}
      <GardenAvatar
        active={active}
        reducedMotion={reducedMotion}
        spawn={layout.spawn}
        extent={layout.extent}
        plots={layout.plots}
        onInteract={onSelectNode}
      />
    </>
  );
}

function GardenGround({ extent }: { extent: number }) {
  const steppingStones = useMemo(() => {
    const stones: Array<[number, number, number]> = [];
    for (let x = -extent + 2; x < extent - 1; x += 3.4) {
      stones.push([x, -extent + 1.2, (Math.abs(Math.round(x)) % 3) * 0.08]);
    }
    return stones;
  }, [extent]);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[extent * 2, extent * 2]} />
        <meshStandardMaterial color="#14251a" roughness={0.96} />
      </mesh>
      <mesh position={[0, 0.035, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[extent * 1.82, extent * 1.82]} />
        <meshStandardMaterial color="#1a3020" roughness={1} />
      </mesh>
      {steppingStones.map(([x, z, offset], index) => (
        <mesh key={index} position={[x, 0.08, z + offset]} receiveShadow>
          <boxGeometry args={[2.6, 0.12, 1.1]} />
          <meshStandardMaterial color="#526052" roughness={0.92} />
        </mesh>
      ))}
    </group>
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
        position={[(sourceX + targetX) / 2, 0.12, (sourceZ + targetZ) / 2]}
        rotation={[0, -angle, 0]}
        receiveShadow
      >
        <boxGeometry args={[length, 0.16, highlighted ? 0.7 : 0.48]} />
        <meshStandardMaterial
          color={highlighted ? '#5ec8ff' : '#41555b'}
          emissive={highlighted ? '#183b4b' : '#000000'}
          roughness={0.8}
        />
      </mesh>
      <mesh position={[markerX, 0.28, markerZ]} rotation={[0, -angle, 0]}>
        <boxGeometry args={[0.5, 0.2, 0.82]} />
        <meshStandardMaterial color={highlighted ? '#a9e5ff' : '#66858a'} />
      </mesh>
    </group>
  );
}

function ModulePavilion({
  plot,
  selected,
  changed,
  onSelect,
  onOpen,
}: {
  plot: GardenPlot;
  selected: boolean;
  changed: boolean;
  onSelect: (nodeId: string) => void;
  onOpen: (nodeId: string) => void;
}) {
  const stopAnd = (callback: () => void) => (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    callback();
  };
  const stone = plot.seed % 2 === 0 ? '#273746' : '#303b43';
  const roof = changed ? '#c9672b' : selected ? '#bd642f' : '#17232c';
  const windowCount = Math.max(2, Math.min(5, Math.round(plot.width)));
  return (
    <group
      position={[plot.x, 0, plot.z]}
      onClick={stopAnd(() => onSelect(plot.node.id))}
      onDoubleClick={stopAnd(() => onOpen(plot.node.id))}
    >
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
      <mesh position={[0, 0.75, plot.depth / 2 + 0.035]}>
        <boxGeometry args={[0.9, 1.2, 0.12]} />
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
      <mesh position={[plot.width / 2 + 0.56, 0.58, plot.depth / 2 + 0.42]} castShadow>
        <boxGeometry args={[0.52, 0.9, 0.52]} />
        <meshStandardMaterial
          color={changed ? '#ff8a3d' : '#6ba184'}
          emissive={changed ? '#7d3315' : '#173c2a'}
          emissiveIntensity={0.5}
        />
      </mesh>
      <GardenPlant x={-plot.width / 2 - 0.65} z={plot.depth / 2 + 0.55} seed={plot.seed} />
      <GardenPlant x={plot.width / 2 + 0.7} z={-plot.depth / 2 - 0.45} seed={plot.seed >> 2} />
      {changed && (
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
      )}
    </group>
  );
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
}: {
  active: boolean;
  reducedMotion: boolean;
  spawn: [number, number];
  extent: number;
  plots: GardenPlot[];
  onInteract: (nodeId: string) => void;
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
        const nearest = nearestPlot(positionRef.current, plots);
        if (nearest && nearest.distance < 5.2) onInteract(nearest.plot.node.id);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => keysRef.current.delete(event.key.toLowerCase());
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [active, onInteract, plots]);

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

function belongsToModule(modulePath: string, filePath: string): boolean {
  const normalized = filePath.replace(/^\.\//, '').replace(/\\/g, '/');
  return modulePath === '.' || normalized === modulePath || normalized.startsWith(`${modulePath}/`);
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
