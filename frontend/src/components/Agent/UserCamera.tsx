"use client";

import { browserMediaUnavailableReason } from "@/lib/audioUtils";
import {
	sendHandGestureAction,
	startLocalHandGestureBridge,
	stopHandGestureBridge,
} from "@/lib/handGesture";
import { sendHeadAction } from "@/lib/headMotion";
import { useT } from "@/lib/i18n";
import {
	CAMERA_QUALITY_PRESETS,
	type CameraQuality,
	useSettings,
} from "@/lib/settingsStore";
import { VideoOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type Landmark = {
	x: number;
	y: number;
	z?: number;
};

type HeartParticle = {
	kind: "heart" | "coin" | "spark" | "ring";
	x: number;
	y: number;
	vx: number;
	vy: number;
	life: number;
	maxLife: number;
	size: number;
	rotation: number;
	spin: number;
	hue: number;
};

type TimedPoint = {
	x: number;
	y: number;
	time: number;
};

type LoveEffect = {
	x: number;
	y: number;
	start: number;
};

type WritingState = {
	active: boolean;
	startedAt: number;
	lastPointAt: number;
	points: TimedPoint[];
};

type HandConnectionEffect = {
	a: Landmark;
	b: Landmark;
	distance: number;
	intensity: number;
};

function clampInterval(value: number, fallback: number, min = 50, max = 1000): number {
	const numeric = Number.isFinite(value) ? value : fallback;
	return Math.min(max, Math.max(min, numeric));
}

const HAND_CONNECTIONS: [number, number][] = [
	[0, 1],
	[1, 2],
	[2, 3],
	[3, 4],
	[0, 5],
	[5, 6],
	[6, 7],
	[7, 8],
	[5, 9],
	[9, 10],
	[10, 11],
	[11, 12],
	[9, 13],
	[13, 14],
	[14, 15],
	[15, 16],
	[13, 17],
	[17, 18],
	[18, 19],
	[19, 20],
	[0, 17],
];

interface UserCameraProps {
	enabled?: boolean;
	transparent?: boolean;
	cameraDeviceId?: string;
	cameraQuality?: CameraQuality;
	/** Read-only previews draw camera/effects but never drive hardware bridges. */
	readOnly?: boolean;
	/** Let dedicated camera pages run independently from the main toolbar toggle. */
	ignoreGlobalCameraEnabled?: boolean;
}

type FaceDetectorLike = {
	detect: (
		source: HTMLVideoElement,
	) => Promise<Array<{ boundingBox: DOMRectReadOnly }>>;
};

type WindowWithFaceDetector = Window & {
	FaceDetector?: new (options?: {
		fastMode?: boolean;
		maxDetectedFaces?: number;
	}) => FaceDetectorLike;
};

type HandednessItem = {
	categoryName?: string;
	category_name?: string;
	displayName?: string;
};

type HandLandmarkerResultLike = {
	landmarks?: Landmark[][];
	handednesses?: HandednessItem[][];
	handedness?: HandednessItem[][];
};

type HandLandmarkerLike = {
	detectForVideo: (
		video: HTMLVideoElement,
		timestampMs: number,
	) => HandLandmarkerResultLike;
	close?: () => void;
};

function distance(a: Landmark, b: Landmark): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function palmWidth(points: Landmark[]): number {
	if (points.length < 21) return 0.001;
	return Math.max(distance(points[5], points[17]), 0.001);
}

function isFingerFolded(points: Landmark[], tip: number, pip: number): boolean {
	if (points.length < 21) return false;
	const width = palmWidth(points);
	const center = palmCenter(points);
	const tipFromWrist = distance(points[tip], points[0]);
	const pipFromWrist = distance(points[pip], points[0]);
	const tipNearPalm = distance(points[tip], center) < width * 0.72;
	return tipNearPalm || tipFromWrist < pipFromWrist + width * 0.15;
}

function isFingerExtended(
	points: Landmark[],
	tip: number,
	pip: number,
): boolean {
	return !isFingerFolded(points, tip, pip);
}

function estimatePattern(points: Landmark[]): string {
	if (points.length < 21) return "000000";

	const width = palmWidth(points);
	const indexFolded = isFingerFolded(points, 8, 6);
	const middleFolded = isFingerFolded(points, 12, 10);
	const ringFolded = isFingerFolded(points, 16, 14);
	const pinkyFolded = isFingerFolded(points, 20, 18);
	const thumbTipToIndexMcp = distance(points[4], points[5]);
	const thumbTipToPalm = distance(points[4], palmCenter(points));
	const thumbFolded =
		thumbTipToIndexMcp < width * 0.58 || thumbTipToPalm < width * 0.74;

	return [
		false,
		indexFolded,
		middleFolded,
		ringFolded,
		thumbFolded,
		pinkyFolded,
	]
		.map((value) => (value ? "1" : "0"))
		.join("");
}

function handTypeFromResult(
	result: HandLandmarkerResultLike,
	index = 0,
): string | null {
	const item =
		result?.handednesses?.[index]?.[0] || result?.handedness?.[index]?.[0];
	return item?.categoryName || item?.category_name || item?.displayName || null;
}

function singleHandHeartAnchor(
	points: Landmark[],
): { x: number; y: number; power: number } | null {
	if (points.length < 21) return null;
	const scale = Math.max(
		palmWidth(points),
		distance(points[0], points[9]) * 0.75,
		0.001,
	);
	const candidates = [
		{ a: 4, b: 8, d: distance(points[4], points[8]) },
		{ a: 4, b: 12, d: distance(points[4], points[12]) },
		{ a: 4, b: 16, d: distance(points[4], points[16]) },
	].sort((left, right) => left.d - right.d);
	const best = candidates[0];
	const fingerTipsNear =
		distance(points[8], points[12]) < scale * 1.08 ||
		distance(points[8], points[16]) < scale * 1.08 ||
		distance(points[12], points[16]) < scale * 1.08;
	const thumbNearFinger = best.d < scale * 0.82;
	const notFullFist =
		isFingerExtended(points, 8, 6) ||
		isFingerExtended(points, 12, 10) ||
		isFingerExtended(points, 16, 14);
	if (
		!thumbNearFinger ||
		(!fingerTipsNear && best.d > scale * 0.58) ||
		!notFullFist
	) {
		return null;
	}
	return {
		x: (points[best.a].x + points[best.b].x) / 2,
		y: (points[best.a].y + points[best.b].y) / 2,
		power: best.b === 12 ? 1.12 : 1,
	};
}

function isSingleHandHeart(points: Landmark[]): boolean {
	return Boolean(singleHandHeartAnchor(points));
}

function detectHeartGesture(
	hands: Landmark[][],
): { x: number; y: number; power: number } | null {
	const validHands = hands.filter((hand) => hand.length >= 21);
	const single = validHands
		.map((hand) => singleHandHeartAnchor(hand))
		.find((gesture): gesture is { x: number; y: number; power: number } =>
			Boolean(gesture),
		);
	if (!single) return null;
	return {
		x: single.x,
		y: single.y,
		power: single.power,
	};
}

function detectTwoHandHeart(
	hands: Landmark[][],
): { x: number; y: number; power: number } | null {
	const validHands = hands.filter((hand) => hand.length >= 21);
	if (validHands.length < 2) return null;
	const [a, b] = validHands;
	const scale = Math.max((palmWidth(a) + palmWidth(b)) / 2, 0.001);
	const indexTipsClose = distance(a[8], b[8]) < scale * 1.28;
	const thumbsClose = distance(a[4], b[4]) < scale * 1.35;
	const crossPinchClose =
		Math.min(
			distance(a[4], b[8]),
			distance(a[8], b[4]),
			distance(a[4], b[12]),
			distance(a[12], b[4]),
		) <
		scale * 1.18;
	const wristsApart = distance(a[0], b[0]) > scale * 1.05;
	if ((!indexTipsClose || !thumbsClose) && !crossPinchClose) return null;
	if (!wristsApart) return null;
	return {
		x: (a[4].x + a[8].x + b[4].x + b[8].x) / 4,
		y: (a[4].y + a[8].y + b[4].y + b[8].y) / 4,
		power: 1.35,
	};
}

function isVGesture(points: Landmark[]): boolean {
	if (points.length < 21) return false;
	const indexExtended = isFingerExtended(points, 8, 6);
	const middleExtended = isFingerExtended(points, 12, 10);
	const ringFolded = isFingerFolded(points, 16, 14);
	const pinkyFolded = isFingerFolded(points, 20, 18);
	const spread = distance(points[8], points[12]) > palmWidth(points) * 0.45;
	return indexExtended && middleExtended && ringFolded && pinkyFolded && spread;
}

function isOkGesture(points: Landmark[]): boolean {
	if (points.length < 21) return false;
	const scale = palmWidth(points);
	const thumbIndexClose = distance(points[4], points[8]) < scale * 0.48;
	const otherFingersVisible =
		isFingerExtended(points, 12, 10) ||
		isFingerExtended(points, 16, 14) ||
		isFingerExtended(points, 20, 18);
	return thumbIndexClose && otherFingersVisible;
}

function detectHandConnection(
	hands: Landmark[][],
): HandConnectionEffect | null {
	const validHands = hands.filter((hand) => hand.length >= 21);
	if (validHands.length < 2) return null;
	const [left, right] = validHands;
	const a = left[8] || palmCenter(left);
	const b = right[8] || palmCenter(right);
	const d = distance(a, b);
	if (d > 0.62) return null;
	const intensity = Math.max(0, Math.min(1, 1 - d / 0.38));
	return { a, b, distance: d, intensity };
}

function palmCenter(points: Landmark[]): { x: number; y: number } {
	if (points.length < 21) return { x: 0.5, y: 0.5 };
	return {
		x:
			(points[0].x + points[5].x + points[9].x + points[13].x + points[17].x) /
			5,
		y:
			(points[0].y + points[5].y + points[9].y + points[13].y + points[17].y) /
			5,
	};
}

function isOpenPalmPattern(pattern: string): boolean {
	return pattern === "000000";
}

function isFistPattern(pattern: string): boolean {
	return pattern === "011111" || pattern === "111111";
}

function spawnHeartParticles(
	particles: HeartParticle[],
	gesture: { x: number; y: number; power: number },
) {
	const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.2;
	const speed = 0.07 + Math.random() * 0.08 * gesture.power;
	particles.push({
		kind: "heart",
		x: gesture.x + (Math.random() - 0.5) * 0.025,
		y: gesture.y + (Math.random() - 0.5) * 0.018,
		vx: Math.cos(angle) * speed + (Math.random() - 0.5) * 0.018,
		vy: Math.sin(angle) * speed - 0.035,
		life: 0,
		maxLife: 1550 + Math.random() * 450,
		size: 0.032 + Math.random() * 0.014 * gesture.power,
		rotation: (Math.random() - 0.5) * 0.32,
		spin: (Math.random() - 0.5) * 0.0018,
		hue: 336 + Math.random() * 24,
	});
	if (particles.length > 90) {
		particles.splice(0, particles.length - 90);
	}
}

function spawnCoinParticles(particles: HeartParticle[], power = 1) {
	const count = Math.round(24 * power);
	for (let i = 0; i < count; i += 1) {
		particles.push({
			kind: "coin",
			x: Math.random(),
			y: -0.08 - Math.random() * 0.26,
			vx: (Math.random() - 0.5) * 0.08,
			vy: 0.18 + Math.random() * 0.32,
			life: 0,
			maxLife: 1250 + Math.random() * 850,
			size: 0.022 + Math.random() * 0.018,
			rotation: Math.random() * Math.PI * 2,
			spin: (Math.random() - 0.5) * 0.018,
			hue: 44 + Math.random() * 10,
		});
	}
	if (particles.length > 240) {
		particles.splice(0, particles.length - 240);
	}
}

function spawnSparkParticles(
	particles: HeartParticle[],
	center: { x: number; y: number },
	power = 1,
) {
	const count = Math.round(12 * power);
	for (let i = 0; i < count; i += 1) {
		const angle = Math.random() * Math.PI * 2;
		const speed = 0.12 + Math.random() * 0.2;
		particles.push({
			kind: "spark",
			x: center.x + (Math.random() - 0.5) * 0.08,
			y: center.y + (Math.random() - 0.5) * 0.08,
			vx: Math.cos(angle) * speed,
			vy: Math.sin(angle) * speed,
			life: 0,
			maxLife: 560 + Math.random() * 360,
			size: 0.012 + Math.random() * 0.012,
			rotation: Math.random() * Math.PI * 2,
			spin: (Math.random() - 0.5) * 0.02,
			hue: 190 + Math.random() * 58,
		});
	}
}

function spawnRingParticles(
	particles: HeartParticle[],
	center: { x: number; y: number },
) {
	particles.push({
		kind: "ring",
		x: center.x,
		y: center.y,
		vx: 0,
		vy: 0,
		life: 0,
		maxLife: 720,
		size: 0.035,
		rotation: 0,
		spin: 0,
		hue: 156,
	});
}

function drawHeart(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	size: number,
	rotation: number,
	hue: number,
	alpha: number,
) {
	ctx.save();
	ctx.translate(x, y);
	ctx.rotate(rotation);
	ctx.scale(size, size);
	ctx.beginPath();
	ctx.moveTo(0, 0.34);
	ctx.bezierCurveTo(-1.35, -0.48, -0.55, -1.34, 0, -0.7);
	ctx.bezierCurveTo(0.55, -1.34, 1.35, -0.48, 0, 0.34);
	ctx.closePath();
	ctx.shadowColor = `hsla(${hue}, 92%, 70%, ${alpha})`;
	ctx.shadowBlur = 12;
	ctx.fillStyle = `hsla(${hue}, 92%, 66%, ${alpha})`;
	ctx.fill();
	ctx.restore();
}

function drawSpark(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	size: number,
	rotation: number,
	hue: number,
	alpha: number,
) {
	ctx.save();
	ctx.translate(x, y);
	ctx.rotate(rotation);
	ctx.strokeStyle = `hsla(${hue}, 95%, 72%, ${alpha})`;
	ctx.shadowColor = `hsla(${hue}, 95%, 68%, ${alpha})`;
	ctx.shadowBlur = 9;
	ctx.lineWidth = Math.max(1.5, size * 0.14);
	ctx.beginPath();
	ctx.moveTo(-size, 0);
	ctx.lineTo(size, 0);
	ctx.moveTo(0, -size);
	ctx.lineTo(0, size);
	ctx.stroke();
	ctx.restore();
}

function drawRing(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	size: number,
	alpha: number,
) {
	ctx.save();
	ctx.beginPath();
	ctx.arc(x, y, size, 0, Math.PI * 2);
	ctx.strokeStyle = `rgba(100, 255, 190, ${alpha})`;
	ctx.shadowColor = `rgba(100, 255, 190, ${alpha})`;
	ctx.shadowBlur = 12;
	ctx.lineWidth = Math.max(2, size * 0.08);
	ctx.stroke();
	ctx.restore();
}

function drawCoin(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	size: number,
	rotation: number,
	alpha: number,
) {
	ctx.save();
	ctx.translate(x, y);
	ctx.rotate(rotation);
	ctx.scale(size, size);
	ctx.beginPath();
	ctx.ellipse(0, 0, 1, 0.76, 0, 0, Math.PI * 2);
	ctx.shadowColor = `rgba(255, 202, 74, ${alpha})`;
	ctx.shadowBlur = 10;
	ctx.fillStyle = `rgba(246, 181, 45, ${alpha})`;
	ctx.fill();
	ctx.lineWidth = 0.12;
	ctx.strokeStyle = `rgba(255, 246, 160, ${alpha})`;
	ctx.stroke();
	ctx.beginPath();
	ctx.rect(-0.18, -0.22, 0.36, 0.44);
	ctx.fillStyle = `rgba(110, 74, 18, ${alpha * 0.82})`;
	ctx.fill();
	ctx.restore();
}

function drawLoveEffect(
	canvas: HTMLCanvasElement,
	video: HTMLVideoElement,
	effect: LoveEffect | null,
	now: number,
): boolean {
	if (!effect) return false;
	const width = video.videoWidth || video.clientWidth || 1;
	const height = video.videoHeight || video.clientHeight || 1;
	const ctx = canvas.getContext("2d");
	if (!ctx) return false;
	const age = now - effect.start;
	const duration = 2500;
	if (age > duration) return false;

	const progress = Math.max(0, Math.min(1, age / 1800));
	const x = effect.x * width;
	const y = effect.y * height;
	const fontSize = Math.max(42, Math.min(width, height) * 0.16);
	const text = "LOVE";
	ctx.save();
	ctx.font = `${fontSize}px "Segoe Script", "Brush Script MT", cursive`;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	const metrics = ctx.measureText(text);
	const textWidth = metrics.width;
	const left = x - textWidth / 2;
	const top = y - fontSize * 0.72;
	const reveal = Math.max(0, Math.min(textWidth, textWidth * progress));
	ctx.beginPath();
	ctx.rect(left - 18, top - 16, reveal + 28, fontSize * 1.55);
	ctx.clip();
	const alpha = Math.min(1, age / 260) * Math.min(1, (duration - age) / 420);
	ctx.lineWidth = Math.max(2, fontSize * 0.045);
	ctx.shadowColor = `rgba(255, 135, 202, ${alpha})`;
	ctx.shadowBlur = 18;
	ctx.strokeStyle = `rgba(255, 244, 252, ${alpha * 0.9})`;
	ctx.fillStyle = `rgba(255, 114, 190, ${alpha})`;
	ctx.strokeText(text, x, y);
	ctx.fillText(text, x, y);
	ctx.restore();

	if (progress > 0.02 && progress < 1) {
		const penX = left + reveal;
		ctx.save();
		ctx.beginPath();
		ctx.arc(penX, y - fontSize * 0.06, fontSize * 0.045, 0, Math.PI * 2);
		ctx.fillStyle = "rgba(255, 235, 250, 0.95)";
		ctx.shadowColor = "rgba(255, 125, 210, 0.95)";
		ctx.shadowBlur = 16;
		ctx.fill();
		ctx.restore();
	}
	return true;
}

function drawPrompt(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	text: string,
) {
	ctx.save();
	const fontSize = Math.max(16, Math.round(width * 0.032));
	ctx.font = `${fontSize}px sans-serif`;
	const paddingX = fontSize * 0.95;
	const paddingY = fontSize * 0.62;
	const metrics = ctx.measureText(text);
	const boxWidth = metrics.width + paddingX * 2;
	const boxHeight = fontSize + paddingY * 2;
	const x = (width - boxWidth) / 2;
	const y = Math.max(height * 0.08, 18);
	ctx.fillStyle = "rgba(9, 16, 32, 0.72)";
	ctx.strokeStyle = "rgba(132, 220, 255, 0.54)";
	ctx.lineWidth = 1.5;
	roundRect(ctx, x, y, boxWidth, boxHeight, boxHeight / 2);
	ctx.fill();
	ctx.stroke();
	ctx.fillStyle = "rgba(240, 250, 255, 0.96)";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(text, width / 2, y + boxHeight / 2);
	ctx.restore();
}

function roundRect(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number,
) {
	const r = Math.min(radius, width / 2, height / 2);
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + width, y, x + width, y + height, r);
	ctx.arcTo(x + width, y + height, x, y + height, r);
	ctx.arcTo(x, y + height, x, y, r);
	ctx.arcTo(x, y, x + width, y, r);
	ctx.closePath();
}

function drawWritingEffect(
	canvas: HTMLCanvasElement,
	video: HTMLVideoElement,
	writing: WritingState,
	now: number,
) {
	if (!writing.active) return;
	const width = video.videoWidth || video.clientWidth || 1;
	const height = video.videoHeight || video.clientHeight || 1;
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	writing.points = writing.points.filter((point) => now - point.time < 7600);
	const points = writing.points;
	if (points.length > 1) {
		ctx.save();
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		for (let i = 1; i < points.length; i += 1) {
			const prev = points[i - 1];
			const point = points[i];
			const alpha = Math.min(1, (7600 - (now - point.time)) / 1800);
			ctx.beginPath();
			ctx.moveTo(prev.x * width, prev.y * height);
			ctx.lineTo(point.x * width, point.y * height);
			ctx.strokeStyle = `rgba(97, 221, 255, ${0.38 + alpha * 0.58})`;
			ctx.shadowColor = `rgba(71, 190, 255, ${alpha})`;
			ctx.shadowBlur = 15;
			ctx.lineWidth = Math.max(4, width * 0.008);
			ctx.stroke();
			ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.72})`;
			ctx.shadowBlur = 0;
			ctx.lineWidth = Math.max(1.5, width * 0.003);
			ctx.stroke();
		}
		const tip = points[points.length - 1];
		ctx.beginPath();
		ctx.arc(
			tip.x * width,
			tip.y * height,
			Math.max(5, width * 0.01),
			0,
			Math.PI * 2,
		);
		ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
		ctx.shadowColor = "rgba(77, 205, 255, 0.9)";
		ctx.shadowBlur = 18;
		ctx.fill();
		ctx.restore();
	}

	const prompt =
		points.length > 4 ? "请比出 OK 手势，释放烟花特效" : "请用食指开始书写";
	drawPrompt(ctx, width, height, prompt);
}

function spawnTraceFireworks(particles: HeartParticle[], points: TimedPoint[]) {
	if (points.length < 2) return;
	const step = Math.max(1, Math.floor(points.length / 34));
	for (let i = 0; i < points.length; i += step) {
		const point = points[i];
		for (let burst = 0; burst < 4; burst += 1) {
			const angle = Math.random() * Math.PI * 2;
			const speed = 0.12 + Math.random() * 0.34;
			particles.push({
				kind: "spark",
				x: point.x,
				y: point.y,
				vx: Math.cos(angle) * speed,
				vy: Math.sin(angle) * speed,
				life: 0,
				maxLife: 850 + Math.random() * 650,
				size: 0.012 + Math.random() * 0.017,
				rotation: Math.random() * Math.PI * 2,
				spin: (Math.random() - 0.5) * 0.024,
				hue: 36 + Math.random() * 230,
			});
		}
	}
	if (particles.length > 260) {
		particles.splice(0, particles.length - 260);
	}
}

function drawHandConnectionEffect(
	canvas: HTMLCanvasElement,
	video: HTMLVideoElement,
	effect: HandConnectionEffect | null,
) {
	if (!effect) return;
	const width = video.videoWidth || video.clientWidth || 1;
	const height = video.videoHeight || video.clientHeight || 1;
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	const ax = effect.a.x * width;
	const ay = effect.a.y * height;
	const bx = effect.b.x * width;
	const by = effect.b.y * height;
	const intensity = effect.intensity;
	ctx.save();
	const gradient = ctx.createLinearGradient(ax, ay, bx, by);
	gradient.addColorStop(0, `rgba(126, 220, 255, ${0.38 + intensity * 0.52})`);
	gradient.addColorStop(0.5, `rgba(255, 236, 150, ${0.44 + intensity * 0.48})`);
	gradient.addColorStop(1, `rgba(255, 142, 214, ${0.38 + intensity * 0.52})`);
	ctx.strokeStyle = gradient;
	ctx.shadowColor = `rgba(255, 226, 155, ${0.6 + intensity * 0.35})`;
	ctx.shadowBlur = 12 + intensity * 18;
	ctx.lineWidth = Math.max(3, width * (0.004 + intensity * 0.006));
	ctx.lineCap = "round";
	ctx.beginPath();
	ctx.moveTo(ax, ay);
	ctx.lineTo(bx, by);
	ctx.stroke();
	const sparkCount = 5 + Math.round(intensity * 10);
	for (let i = 0; i < sparkCount; i += 1) {
		const t = (i + 0.5) / sparkCount;
		const jitter = (Math.random() - 0.5) * 10;
		const x = ax + (bx - ax) * t + jitter;
		const y = ay + (by - ay) * t - jitter;
		ctx.beginPath();
		ctx.arc(x, y, 1.6 + intensity * 2.4, 0, Math.PI * 2);
		ctx.fillStyle = `rgba(255, 250, 214, ${0.45 + intensity * 0.45})`;
		ctx.fill();
	}
	if (intensity > 0.78) {
		drawHeart(
			ctx,
			(ax + bx) / 2,
			(ay + by) / 2,
			Math.min(width, height) * (0.05 + intensity * 0.025),
			0,
			336,
			0.68,
		);
	}
	ctx.restore();
}

function spawnConnectionFinalParticles(
	particles: HeartParticle[],
	effect: HandConnectionEffect,
) {
	const center = {
		x: (effect.a.x + effect.b.x) / 2,
		y: (effect.a.y + effect.b.y) / 2,
	};
	spawnRingParticles(particles, center);
	spawnSparkParticles(particles, center, 2.2);
	for (let i = 0; i < 8; i += 1) {
		spawnHeartParticles(particles, { x: center.x, y: center.y, power: 1.25 });
	}
}

function drawParticles(
	canvas: HTMLCanvasElement,
	video: HTMLVideoElement,
	particles: HeartParticle[],
	dtMs: number,
) {
	const width = video.videoWidth || video.clientWidth || 1;
	const height = video.videoHeight || video.clientHeight || 1;
	if (canvas.width !== width) canvas.width = width;
	if (canvas.height !== height) canvas.height = height;

	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	ctx.clearRect(0, 0, width, height);

	const dtSeconds = Math.min(dtMs, 48) / 1000;
	for (let i = particles.length - 1; i >= 0; i -= 1) {
		const particle = particles[i];
		particle.life += dtMs;
		if (particle.life >= particle.maxLife) {
			particles.splice(i, 1);
			continue;
		}
		particle.x += particle.vx * dtSeconds;
		particle.y += particle.vy * dtSeconds;
		particle.vy +=
			(particle.kind === "coin" ? 0.32 : particle.kind === "ring" ? 0 : 0.07) *
			dtSeconds;
		particle.rotation += particle.spin * dtMs;
		const age = particle.life / particle.maxLife;
		const fadeIn = particle.kind === "heart" ? Math.min(1, age / 0.16) : 1;
		const alpha = Math.sin((1 - age) * Math.PI * 0.5) * 0.92 * fadeIn;
		const grow =
			particle.kind === "heart"
				? 0.45 + Math.sin(Math.min(1, age / 0.46) * Math.PI * 0.5) * 0.75
				: 1;
		if (particle.kind === "coin") {
			drawCoin(
				ctx,
				particle.x * width,
				particle.y * height,
				particle.size * Math.min(width, height),
				particle.rotation,
				alpha,
			);
		} else if (particle.kind === "spark") {
			drawSpark(
				ctx,
				particle.x * width,
				particle.y * height,
				particle.size * Math.min(width, height),
				particle.rotation,
				particle.hue,
				alpha,
			);
		} else if (particle.kind === "ring") {
			drawRing(
				ctx,
				particle.x * width,
				particle.y * height,
				particle.size * Math.min(width, height) * (1 + age * 4.2),
				alpha * (1 - age),
			);
		} else {
			drawHeart(
				ctx,
				particle.x * width,
				particle.y * height,
				particle.size * Math.min(width, height) * grow,
				particle.rotation,
				particle.hue,
				alpha,
			);
		}
	}
}

function parsePortList(value: string): string[] {
	return value
		.replace(/[;\uff1b\uff0c\s]+/g, ",")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function buildCameraConstraints(
	deviceId: string,
	quality: keyof typeof CAMERA_QUALITY_PRESETS,
): MediaTrackConstraints {
	const preset =
		CAMERA_QUALITY_PRESETS[quality] ?? CAMERA_QUALITY_PRESETS.high;
	const constraints: MediaTrackConstraints = {
		width: { ideal: preset.width },
		height: { ideal: preset.height },
		frameRate: { ideal: preset.frameRate },
	};
	if (deviceId) {
		constraints.deviceId = { exact: deviceId };
	} else {
		constraints.facingMode = { ideal: "user" };
	}
	return constraints;
}

function drawHandSkeleton(
	canvas: HTMLCanvasElement,
	video: HTMLVideoElement,
	hands: Landmark[][] = [],
	pattern = "000000",
) {
	const width = video.videoWidth || video.clientWidth || 1;
	const height = video.videoHeight || video.clientHeight || 1;
	if (canvas.width !== width) canvas.width = width;
	if (canvas.height !== height) canvas.height = height;

	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	ctx.clearRect(0, 0, width, height);
	if (!hands.length) return;

	ctx.save();
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	ctx.shadowColor = "rgba(0, 0, 0, 0.65)";
	ctx.shadowBlur = 5;

	hands.forEach((points, handIndex) => {
		const stroke =
			handIndex === 0
				? "rgba(126, 211, 255, 0.95)"
				: "rgba(255, 154, 216, 0.94)";
		const fill =
			handIndex === 0
				? "rgba(94, 255, 180, 0.98)"
				: "rgba(255, 180, 230, 0.98)";

		for (const [from, to] of HAND_CONNECTIONS) {
			const a = points[from];
			const b = points[to];
			if (!a || !b) continue;
			ctx.beginPath();
			ctx.moveTo(a.x * width, a.y * height);
			ctx.lineTo(b.x * width, b.y * height);
			ctx.strokeStyle = stroke;
			ctx.lineWidth = Math.max(3, width * 0.005);
			ctx.stroke();
		}

		for (let i = 0; i < points.length; i += 1) {
			const point = points[i];
			ctx.beginPath();
			ctx.arc(
				point.x * width,
				point.y * height,
				i === 0 ? Math.max(5, width * 0.009) : Math.max(3.5, width * 0.006),
				0,
				Math.PI * 2,
			);
			ctx.fillStyle = i === 0 ? "rgba(255, 229, 125, 0.98)" : fill;
			ctx.fill();
		}
	});

	ctx.shadowBlur = 0;
	ctx.font = `${Math.max(13, Math.round(width * 0.035))}px sans-serif`;
	ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
	ctx.fillText(
		hands.length > 1 ? `${pattern}  x${hands.length}` : pattern,
		Math.max(10, width * 0.03),
		Math.max(22, height * 0.08),
	);
	ctx.restore();
}

export function UserCamera({
	enabled = true,
	transparent = false,
	cameraDeviceId,
	cameraQuality,
	readOnly = false,
	ignoreGlobalCameraEnabled = false,
}: UserCameraProps) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const particleCanvasRef = useRef<HTMLCanvasElement>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const rafRef = useRef<number | null>(null);
	const particlesRef = useRef<HeartParticle[]>([]);
	const lastSentRef = useRef("");
	const candidateRef = useRef("000000");
	const candidateCountRef = useRef(0);
	const lastSentAtRef = useRef(0);
	const lastHandRecognizedAtRef = useRef(0);
	const lastParticleBurstAtRef = useRef(0);
	const lastParticleFrameAtRef = useRef(0);
	const lastSparkAtRef = useRef(0);
	const lastRingAtRef = useRef(0);
	const lastLoveAtRef = useRef(0);
	const loveEffectRef = useRef<LoveEffect | null>(null);
	const writingRef = useRef<WritingState>({
		active: false,
		startedAt: 0,
		lastPointAt: 0,
		points: [],
	});
	const lastConnectionFinalAtRef = useRef(0);
	const handBridgeActiveRef = useRef(false);
	const faceDetectorRef = useRef<FaceDetectorLike | null>(null);
	const faceDetectInFlightRef = useRef(false);
	const smoothedFaceXRef = useRef<number | null>(null);
	const lastEyeTrackAtRef = useRef(0);
	const lastEyeAngleRef = useRef(90);
	const lastNeckAngleRef = useRef(90);
	const [error, setError] = useState<string | null>(null);
	const [streamVersion, setStreamVersion] = useState(0);
	const [settings] = useSettings();
	const t = useT();
	const activeCameraDeviceId = cameraDeviceId ?? settings.cameraDeviceId;
	const activeCameraQuality = cameraQuality ?? settings.cameraQuality;
	const globalCameraAllowed = ignoreGlobalCameraEnabled || settings.cameraEnabled;

	useEffect(() => {
		if (!enabled) {
			for (const track of streamRef.current?.getTracks() ?? []) track.stop();
			streamRef.current = null;
			if (videoRef.current) videoRef.current.srcObject = null;
			canvasRef.current
				?.getContext("2d")
				?.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
			particleCanvasRef.current
				?.getContext("2d")
				?.clearRect(
					0,
					0,
					particleCanvasRef.current.width,
					particleCanvasRef.current.height,
				);
			particlesRef.current = [];
			loveEffectRef.current = null;
			writingRef.current = {
				active: false,
				startedAt: 0,
				lastPointAt: 0,
				points: [],
			};
			setError(null);
			return;
		}

		let cancelled = false;

		const start = async () => {
			try {
				const unavailable = browserMediaUnavailableReason("camera");
				if (unavailable) throw new Error(unavailable);
				const requestedDeviceId = activeCameraDeviceId.trim();
				let stream: MediaStream;
				try {
					stream = await navigator.mediaDevices.getUserMedia({
						video: buildCameraConstraints(
							requestedDeviceId,
							activeCameraQuality,
						),
						audio: false,
					});
				} catch (firstError) {
					if (!requestedDeviceId) throw firstError;
					console.warn(
						"Selected camera failed; falling back to browser default:",
						firstError,
					);
					stream = await navigator.mediaDevices.getUserMedia({
						video: buildCameraConstraints("", activeCameraQuality),
						audio: false,
					});
				}
				if (cancelled) {
					for (const track of stream.getTracks()) track.stop();
					return;
				}
				streamRef.current = stream;
				setStreamVersion((version) => version + 1);
				if (videoRef.current) videoRef.current.srcObject = stream;
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			}
		};

		start();

		return () => {
			cancelled = true;
			for (const track of streamRef.current?.getTracks() ?? []) track.stop();
			streamRef.current = null;
		};
	}, [enabled, activeCameraDeviceId, activeCameraQuality]);

	useEffect(() => {
		void streamVersion;
		const releaseHandBridge = () => {
			if (!handBridgeActiveRef.current) return;
			handBridgeActiveRef.current = false;
			lastSentRef.current = "";
			lastSentAtRef.current = 0;
			lastHandRecognizedAtRef.current = 0;
			candidateRef.current = "000000";
			candidateCountRef.current = 0;
			void sendHandGestureAction("open", "000000").catch(() => {});
			void stopHandGestureBridge().catch(() => {});
		};

		if (
			!enabled ||
			!settings.consentAccepted ||
			!globalCameraAllowed ||
			(!settings.handGestureEnabled &&
				!settings.robotHeadEyeTrackingEnabled &&
				!settings.handGestureParticleEffectsEnabled)
		) {
			canvasRef.current
				?.getContext("2d")
				?.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
			particleCanvasRef.current
				?.getContext("2d")
				?.clearRect(
					0,
					0,
					particleCanvasRef.current.width,
					particleCanvasRef.current.height,
				);
			particlesRef.current = [];
			loveEffectRef.current = null;
			writingRef.current = {
				active: false,
				startedAt: 0,
				lastPointAt: 0,
				points: [],
			};
			releaseHandBridge();
			return;
		}

		const video = videoRef.current;
		const canvas = canvasRef.current;
		const particleCanvas = particleCanvasRef.current;
		if (!video || !canvas || !streamRef.current) return;

		let cancelled = false;
		let landmarker: HandLandmarkerLike | null = null;

		const maybeTrackFace = (now: number) => {
			if (
				readOnly ||
				!settings.robotHeadEyeTrackingEnabled ||
				!settings.robotHeadMotionEnabled ||
				!settings.consentAccepted ||
				faceDetectInFlightRef.current ||
				now - lastEyeTrackAtRef.current < 280
			) {
				return;
			}
			const detector = faceDetectorRef.current;
			if (!detector || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA)
				return;
			faceDetectInFlightRef.current = true;
			lastEyeTrackAtRef.current = now;
			detector
				.detect(video)
				.then((faces) => {
					const face = faces?.[0];
					if (!face?.boundingBox) return;
					const videoWidth = video.videoWidth || video.clientWidth || 1;
					const box = face.boundingBox;
					const rawCenterX = (box.x + box.width / 2) / videoWidth;
					const centered =
						(rawCenterX - 0.5) *
						(settings.robotHeadEyeTrackingInvertX ? -1 : 1);
					const smoothed =
						smoothedFaceXRef.current === null
							? centered
							: smoothedFaceXRef.current * 0.72 + centered * 0.28;
					smoothedFaceXRef.current = smoothed;
					const eyeDelta =
						Math.max(-1, Math.min(1, smoothed * 2)) *
						settings.robotHeadEyeTrackingMaxEyeAngle;
					const eyeAngle = Math.round(
						Math.max(72, Math.min(108, 90 + eyeDelta)),
					);
					if (Math.abs(eyeAngle - lastEyeAngleRef.current) >= 2) {
						lastEyeAngleRef.current = eyeAngle;
						sendHeadAction("servo", {
							location: 3,
							angle: eyeAngle,
							source: "face_tracking",
						}).catch(() => {});
					}
					if (
						settings.robotHeadEyeTrackingNeckFollow &&
						Math.abs(smoothed) > 0.16
					) {
						const neckDelta =
							Math.max(-1, Math.min(1, smoothed * 2)) *
							settings.robotHeadEyeTrackingMaxNeckAngle;
						const neckAngle = Math.round(
							Math.max(63, Math.min(117, 90 + neckDelta)),
						);
						if (Math.abs(neckAngle - lastNeckAngleRef.current) >= 3) {
							lastNeckAngleRef.current = neckAngle;
							sendHeadAction("servo", {
								location: 7,
								angle: neckAngle,
								source: "face_tracking",
							}).catch(() => {});
						}
					}
				})
				.catch(() => {})
				.finally(() => {
					faceDetectInFlightRef.current = false;
				});
		};

		const stop = () => {
			if (rafRef.current !== null) {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
			}
			if (landmarker?.close) landmarker.close();
			canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
			particleCanvas
				?.getContext("2d")
				?.clearRect(0, 0, particleCanvas.width, particleCanvas.height);
			particlesRef.current = [];
			loveEffectRef.current = null;
			writingRef.current = {
				active: false,
				startedAt: 0,
				lastPointAt: 0,
				points: [],
			};
			lastParticleFrameAtRef.current = 0;
		};

		const start = async () => {
			try {
				if (settings.handGestureEnabled && !readOnly) {
					await startLocalHandGestureBridge({
						camera_index: settings.handGestureCameraIndex,
						arduino_ports: parsePortList(settings.handGestureArduinoPorts),
						baud: settings.handGestureBaud,
						dry_run: settings.handGestureDryRun,
						arduino_enabled: settings.handGestureArduinoEnabled,
						send_interval_ms: clampInterval(settings.handGestureSendIntervalMs, 120),
						orca_enabled: settings.handGestureOrcaEnabled,
						orca_port: settings.handGestureOrcaPort,
						orca_direct_joint_enabled:
							settings.handGestureOrcaDirectJointEnabled,
						orca_wrist_follow_enabled:
							settings.handGestureOrcaWristFollowEnabled,
					});
					handBridgeActiveRef.current = true;
					lastSentRef.current = "";
					lastSentAtRef.current = 0;
					lastHandRecognizedAtRef.current = 0;
				}
				const FaceDetectorCtor = (window as WindowWithFaceDetector)
					.FaceDetector;
				faceDetectorRef.current = FaceDetectorCtor
					? new FaceDetectorCtor({ fastMode: true, maxDetectedFaces: 1 })
					: null;

				if (
					settings.handGestureEnabled ||
					settings.handGestureParticleEffectsEnabled
				) {
					const { FilesetResolver, HandLandmarker } = await import(
						"@mediapipe/tasks-vision"
					);
					if (cancelled) return;

					const vision =
						await FilesetResolver.forVisionTasks("/mediapipe/wasm");
					const createLandmarker = (delegate: "GPU" | "CPU") =>
						HandLandmarker.createFromOptions(vision, {
							baseOptions: {
								modelAssetPath: "/mediapipe/hand_landmarker.task",
								delegate,
							},
							runningMode: "VIDEO",
							numHands: 2,
							minHandDetectionConfidence: 0.5,
							minHandPresenceConfidence: 0.5,
							minTrackingConfidence: 0.5,
						});
					try {
						landmarker = await createLandmarker("GPU");
					} catch {
						landmarker = await createLandmarker("CPU");
					}
				}

				const tick = () => {
					if (cancelled) return;
					const now = performance.now();
					if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
						maybeTrackFace(now);
						const recognitionInterval = clampInterval(
							settings.handGestureRecognitionIntervalMs,
							90,
						);
						const sendInterval = clampInterval(
							settings.handGestureSendIntervalMs,
							120,
						);
						if (now - lastHandRecognizedAtRef.current < recognitionInterval) {
							rafRef.current = requestAnimationFrame(tick);
							return;
						}
						lastHandRecognizedAtRef.current = now;
						if (!landmarker) {
							rafRef.current = requestAnimationFrame(tick);
							return;
						}
						const result = landmarker.detectForVideo(video, now);
						const hands = ((result.landmarks || []) as Landmark[][]).filter(
							(points) => points.length >= 21,
						);
						const primaryHand = hands[0];
						const pattern = primaryHand
							? estimatePattern(primaryHand)
							: "000000";
						const handType = primaryHand ? handTypeFromResult(result, 0) : null;
						drawHandSkeleton(canvas, video, hands, pattern);

						if (particleCanvas && settings.handGestureParticleEffectsEnabled) {
							const dtMs = lastParticleFrameAtRef.current
								? now - lastParticleFrameAtRef.current
								: 16;
							lastParticleFrameAtRef.current = now;

							const twoHandHeart = detectTwoHandHeart(hands);
							if (twoHandHeart && now - lastLoveAtRef.current > 1800) {
								loveEffectRef.current = {
									x: twoHandHeart.x,
									y: twoHandHeart.y,
									start: now,
								};
								lastLoveAtRef.current = now;
							}

							const connection = detectHandConnection(hands);
							if (
								connection &&
								!twoHandHeart &&
								connection.intensity > 0.82 &&
								now - lastConnectionFinalAtRef.current > 1400
							) {
								spawnConnectionFinalParticles(particlesRef.current, connection);
								lastConnectionFinalAtRef.current = now;
							}

							const heart = twoHandHeart ? null : detectHeartGesture(hands);
							if (heart && now - lastParticleBurstAtRef.current > 190) {
								spawnHeartParticles(particlesRef.current, heart);
								lastParticleBurstAtRef.current = now;
							}
							if (
								primaryHand &&
								isOpenPalmPattern(pattern) &&
								now - lastSparkAtRef.current > 820
							) {
								spawnSparkParticles(
									particlesRef.current,
									palmCenter(primaryHand),
									hands.length > 1 ? 1.5 : 1,
								);
								lastSparkAtRef.current = now;
							}
							if (
								primaryHand &&
								isFistPattern(pattern) &&
								now - lastRingAtRef.current > 900
							) {
								spawnRingParticles(
									particlesRef.current,
									palmCenter(primaryHand),
								);
								lastRingAtRef.current = now;
							}

							const writing = writingRef.current;
							if (primaryHand && isVGesture(primaryHand) && !writing.active) {
								writingRef.current = {
									active: true,
									startedAt: now,
									lastPointAt: 0,
									points: [],
								};
							}
							if (writingRef.current.active && primaryHand) {
								if (
									isOkGesture(primaryHand) &&
									writingRef.current.points.length > 6 &&
									now - writingRef.current.startedAt > 650
								) {
									spawnTraceFireworks(
										particlesRef.current,
										writingRef.current.points,
									);
									writingRef.current = {
										active: false,
										startedAt: 0,
										lastPointAt: 0,
										points: [],
									};
								} else {
									const tip = primaryHand[8];
									const points = writingRef.current.points;
									const last = points[points.length - 1];
									if (
										!last ||
										(now - writingRef.current.lastPointAt > 36 &&
											distance(last, tip) > 0.006)
									) {
										points.push({ x: tip.x, y: tip.y, time: now });
										writingRef.current.lastPointAt = now;
										if (points.length > 180)
											points.splice(0, points.length - 180);
									}
								}
							}
							if (
								writingRef.current.active &&
								now - writingRef.current.startedAt > 15000
							) {
								writingRef.current = {
									active: false,
									startedAt: 0,
									lastPointAt: 0,
									points: [],
								};
							}

							drawParticles(particleCanvas, video, particlesRef.current, dtMs);
							drawHandConnectionEffect(particleCanvas, video, connection);
							if (
								!drawLoveEffect(
									particleCanvas,
									video,
									loveEffectRef.current,
									now,
								)
							) {
								loveEffectRef.current = null;
							}
							drawWritingEffect(particleCanvas, video, writingRef.current, now);
						} else {
							particlesRef.current = [];
							loveEffectRef.current = null;
							writingRef.current = {
								active: false,
								startedAt: 0,
								lastPointAt: 0,
								points: [],
							};
						}

						if (pattern === candidateRef.current) {
							candidateCountRef.current += 1;
						} else {
							candidateRef.current = pattern;
							candidateCountRef.current = 1;
						}

						if (!readOnly) {
							const continuousHand =
								Boolean(primaryHand) &&
								settings.handGestureEnabled &&
								handBridgeActiveRef.current;

							if (
								continuousHand &&
								primaryHand &&
								now - lastSentAtRef.current >= sendInterval
							) {
								lastSentRef.current = pattern;
								lastSentAtRef.current = now;
								sendHandGestureAction(
									"",
									pattern,
									primaryHand,
									handType,
									"camera",
								).catch((error) => {
									console.warn("Hand gesture landmarks failed:", error);
								});
							} else if (
								candidateCountRef.current >= 2 &&
								pattern !== lastSentRef.current &&
								now - lastSentAtRef.current >= sendInterval
							) {
								lastSentRef.current = pattern;
								lastSentAtRef.current = now;
								sendHandGestureAction(
									"",
									pattern,
									primaryHand,
									handType,
									"camera",
								).catch((error) => {
									console.warn("Hand gesture action failed:", error);
								});
							}
						}
					}
					rafRef.current = requestAnimationFrame(tick);
				};

				rafRef.current = requestAnimationFrame(tick);
			} catch (e) {
				console.error("Hand skeleton overlay failed:", e);
				stop();
			}
		};

		start();

		return () => {
			cancelled = true;
			stop();
			releaseHandBridge();
		};
	}, [
		enabled,
		streamVersion,
		settings.consentAccepted,
		globalCameraAllowed,
		settings.handGestureEnabled,
		settings.handGestureCameraIndex,
		settings.handGestureArduinoPorts,
		settings.handGestureBaud,
		settings.handGestureRecognitionIntervalMs,
		settings.handGestureSendIntervalMs,
		settings.handGestureDryRun,
		settings.handGestureArduinoEnabled,
		settings.handGestureOrcaEnabled,
		settings.handGestureOrcaPort,
		settings.handGestureOrcaDirectJointEnabled,
		settings.handGestureOrcaWristFollowEnabled,
		settings.handGestureParticleEffectsEnabled,
		readOnly,
		settings.robotHeadEyeTrackingEnabled,
		settings.robotHeadEyeTrackingInvertX,
		settings.robotHeadEyeTrackingMaxEyeAngle,
		settings.robotHeadEyeTrackingMaxNeckAngle,
		settings.robotHeadEyeTrackingNeckFollow,
		settings.robotHeadMotionEnabled,
	]);

	return (
		<div
			className={`relative h-full w-full overflow-hidden rounded-xl ${
				transparent
					? "bg-transparent"
					: "bg-gradient-to-b from-slate-900 to-slate-950"
			}`}
		>
			{!enabled ? (
				<div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-sm text-white/70">
					<VideoOff className="h-6 w-6" />
					<div>{t("camera.off")}</div>
				</div>
			) : error ? (
				<div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-sm text-white/70">
					<VideoOff className="h-6 w-6" />
					<div>{t("camera.unavailable")}</div>
					<div className="text-white/40 text-xs">{error}</div>
				</div>
			) : (
				<>
					<video
						ref={videoRef}
						autoPlay
						playsInline
						muted
						className="h-full w-full scale-x-[-1] object-cover"
					/>
					<canvas
						ref={canvasRef}
						className="pointer-events-none absolute inset-0 h-full w-full scale-x-[-1] object-cover"
					/>
					<canvas
						ref={particleCanvasRef}
						className="pointer-events-none absolute inset-0 h-full w-full scale-x-[-1] object-cover"
					/>
				</>
			)}
		</div>
	);
}
