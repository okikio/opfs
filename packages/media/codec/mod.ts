import { z } from 'zod';

/** Video codec names used by media output requests. */
export const VideoCodecSchema = z.enum(['avc', 'hevc', 'vp8', 'vp9', 'av1', 'prores']);

/** Audio codec names used by media output requests. */
export const AudioCodecSchema = z.enum(['aac', 'opus', 'mp3', 'vorbis', 'flac', 'ac3', 'eac3', 'pcm']);

/** Validated video codec name. */
export type VideoCodecType = z.output<typeof VideoCodecSchema>;

/** Validated audio codec name. */
export type AudioCodecType = z.output<typeof AudioCodecSchema>;

/**
 * Returns whether a codec belongs to the video or audio vocabulary.
 *
 * Impact: This operation classifies project vocabulary only. It does not claim
 * that the current browser can decode or encode the codec.
 *
 * @example
 * ```ts
 * getKind('avc'); // 'video'
 * ```
 */
export function getKind(codec: string): 'video' | 'audio' | undefined {
	if (VideoCodecSchema.safeParse(codec).success) return 'video';
	if (AudioCodecSchema.safeParse(codec).success) return 'audio';
	return undefined;
}
