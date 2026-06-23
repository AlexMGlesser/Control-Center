// Neural Network Animation Module

const neuralState = {
  isSpeaking: false,
  ready: false
};

export function setNeuralSpeaking(isSpeaking) {
  neuralState.isSpeaking = Boolean(isSpeaking);
}

export function initializeNeuralNetwork(canvasId = "app-neural-canvas") {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const container = canvas.parentElement;

  let viewWidth = 0;
  let viewHeight = 0;
  const nodes = [];
  const connections = [];
  const nodeCount = 52;
  let sphereRadius = 0;
  let centerX = 0;
  let centerY = 0;

  function rebuildNetworkGeometry() {
    nodes.length = 0;
    connections.length = 0;
    sphereRadius = Math.min(viewWidth, viewHeight) * 0.42;
    centerX = viewWidth / 2;
    centerY = viewHeight / 2;

    for (let i = 0; i < nodeCount; i++) {
      const phi = Math.acos(-1 + (2 * i) / nodeCount);
      const theta = Math.sqrt(nodeCount * Math.PI) * phi;

      const x = centerX + sphereRadius * Math.sin(phi) * Math.cos(theta);
      const y = centerY + sphereRadius * Math.sin(phi) * Math.sin(theta);
      const z = sphereRadius * Math.cos(phi);

      nodes.push({
        x, y, z,
        baseX: x,
        baseY: y,
        baseZ: z,
        pulsePhase: Math.random() * Math.PI * 2,
        speechPhase: Math.random() * Math.PI * 2,
        speechWeight: 0,
        radius: 3.6 + Math.random() * 2.8,
        color: `hsl(${212 + Math.random() * 8}, 100%, ${58 + Math.random() * 18}%)`
      });
    }

    const visualizerCount = Math.max(8, Math.floor(nodeCount * 0.28));
    // Pick reactive nodes from a centered, slightly lower "mouth zone" cluster.
    const mouthCenterX = centerX;
    const mouthCenterY = centerY + sphereRadius * 0.18;
    const visualizerIndexes = Array.from({ length: nodeCount }, (_, idx) => idx)
      .map((idx) => {
        const node = nodes[idx];
        const dx = node.baseX - mouthCenterX;
        const dy = node.baseY - mouthCenterY;
        const radialDistance = Math.sqrt(dx * dx + dy * dy);
        const lowerBiasPenalty = node.baseY < centerY ? sphereRadius * 0.18 : 0;
        return {
          idx,
          score: radialDistance + lowerBiasPenalty + Math.abs(node.baseZ) * 0.15
        };
      })
      .sort((a, b) => a.score - b.score)
      .slice(0, visualizerCount)
      .map((entry) => entry.idx);

    visualizerIndexes.forEach((idx, order) => {
      nodes[idx].speechWeight = 0.8 + Math.sin(order * 1.7) * 0.2;
      nodes[idx].speechPhase = (order / Math.max(1, visualizerCount - 1)) * Math.PI * 2;
    });

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].baseX - nodes[j].baseX;
        const dy = nodes[i].baseY - nodes[j].baseY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < sphereRadius * 0.72) {
          connections.push({
            from: i,
            to: j,
            baseStrength: Math.random() * 0.55 + 0.35,
            pulsePhase: Math.random() * Math.PI * 2
          });
        }
      }
    }
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    viewWidth = Math.max(1, container.clientWidth);
    viewHeight = Math.max(1, container.clientHeight);
    canvas.width = Math.floor(viewWidth * dpr);
    canvas.height = Math.floor(viewHeight * dpr);
    canvas.style.width = `${viewWidth}px`;
    canvas.style.height = `${viewHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rebuildNetworkGeometry();
  }

  resizeCanvas();
  const resizeListener = () => resizeCanvas();
  window.addEventListener("resize", resizeListener);

  let animationId = null;
  let time = 0;
  let isAnimating = true;

  function animate() {
    if (!isAnimating) return;
    
    time += 1;
    const tSec = time / 60;
    
    // Keep a persistent field while allowing subtle motion trails.
    ctx.fillStyle = "rgba(3, 7, 16, 0.09)";
    ctx.fillRect(0, 0, viewWidth, viewHeight);

    const speechActive = neuralState.isSpeaking;
    const speechCarrier = speechActive
      ? Math.max(0, Math.sin(tSec * Math.PI * 2 * 4.6) * 0.7 + Math.sin(tSec * Math.PI * 2 * 6.9) * 0.3)
      : 0;

    // Draw connections
    connections.forEach((conn) => {
      const fromNode = nodes[conn.from];
      const toNode = nodes[conn.to];
      
      // Keep lines continuously visible with a mild shimmer.
      const shimmer = 0.85 + Math.sin(time * 0.035 + conn.pulsePhase) * 0.15;
      const opacity = Math.min(1, conn.baseStrength * shimmer + (speechActive ? speechCarrier * 0.2 : 0));
      
      ctx.strokeStyle = `rgba(62, 152, 255, ${opacity})`;
      ctx.lineWidth = 1.35 + (speechActive ? 0.55 + speechCarrier * 0.9 : 0.45);
      ctx.beginPath();
      ctx.moveTo(fromNode.x, fromNode.y);
      ctx.lineTo(toNode.x, toNode.y);
      ctx.stroke();
    });

    // Draw nodes
    nodes.forEach((node, idx) => {
      // Orbital motion around base position
      const angle = time * 0.008 + idx;
      const orbitRadius = 18 + Math.sin(time * 0.018 + idx) * 7;
      
      node.x = node.baseX + Math.cos(angle) * orbitRadius;
      node.y = node.baseY + Math.sin(angle * 0.72) * orbitRadius;
      
      const nodeSpeechEnvelope = speechActive
        ? Math.max(0, Math.sin(tSec * Math.PI * 2 * (4.2 + node.speechWeight * 1.8) + node.speechPhase))
        : 0;
      const visualizerBoost = node.speechWeight * nodeSpeechEnvelope * speechCarrier;
      const basePulse = 0.18;
      const glowRadius = node.radius * (1 + basePulse + visualizerBoost * 1.7);
      
      // Draw glow
      const gradient = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, glowRadius * 2);
      gradient.addColorStop(0, `rgba(70, 165, 255, ${0.16 + visualizerBoost * 0.72})`);
      gradient.addColorStop(1, "rgba(70, 165, 255, 0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(node.x - glowRadius * 2, node.y - glowRadius * 2, glowRadius * 4, glowRadius * 4);
      
      // Draw node core
      ctx.fillStyle = node.color;
      ctx.beginPath();
      ctx.arc(node.x, node.y, glowRadius, 0, Math.PI * 2);
      ctx.fill();
      
      // Draw bright center
      ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
      ctx.beginPath();
      ctx.arc(node.x, node.y, glowRadius * 0.4, 0, Math.PI * 2);
      ctx.fill();
    });

    animationId = requestAnimationFrame(animate);
  }

  animate();
  neuralState.ready = true;
  
  // Return cleanup function
  return () => {
    isAnimating = false;
    neuralState.ready = false;
    if (animationId) cancelAnimationFrame(animationId);
    window.removeEventListener("resize", resizeListener);
  };
}
