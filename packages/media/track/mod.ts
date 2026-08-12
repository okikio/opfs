import { z } from 'zod';

/** Normalized video track metadata. */
export const VideoTrackSchema = z.object({
	id: z.string().min(1), kind: z.literal('video'), codec: z.string().min(1), width: z.number().int().positive(),
	height: z.number().int().positive(), bitrate: z.number().nonnegative().optional(), language: z.string().optional(),
}).strict();

/** Normalized audio track metadata. */
export const AudioTrackSchema = z.object({
	id: z.string().min(1), kind: z.literal('audio'), codec: z.string().min(1), channels: z.number().int().positive(),
	sampleRate: z.number().int().positive(), bitrate: z.number().nonnegative().optional(), language: z.string().optional(),
}).strict();

/** Normalized media track. */
export const TrackSchema = z.discriminatedUnion('kind', [VideoTrackSchema, AudioTrackSchema]);
/** Normalized media track type. */
export type TrackType = z.output<typeof TrackSchema>;

/** Selects the highest-resolution video track from a set of tracks. */
export function selectVideo(tracks: readonly TrackType[]): TrackType | undefined {
	return tracks.filter((track) => track.kind === 'video').toSorted((a, b) => {
		if (a.kind !== 'video' || b.kind !== 'video') return 0;
		return (b.width * b.height) - (a.width * a.height);
	})[0];
}
