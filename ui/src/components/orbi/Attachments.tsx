import { useEffect, useRef, useState } from 'react';
import type { AttachmentUpload } from '../../api/assistant';

/** Images and audios waiting to go with the next message to Órbi. */

const MAX_FILES = 8;
const MAX_FILE_BYTES = 10_000_000;
export const ACCEPTED = 'image/png,image/jpeg,image/gif,image/webp,audio/webm,audio/ogg,audio/mpeg,audio/wav,audio/mp4,audio/x-m4a';

export interface PendingAttachment extends AttachmentUpload {
  id: string;
  /** Object URL for the preview. */
  preview: string;
}

function toBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('Não foi possível ler o arquivo.'));
    reader.readAsDataURL(blob);
  });
}

export function useAttachments() {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => () => itemsRef.current.forEach((item) => URL.revokeObjectURL(item.preview)), []);

  const add = async (blob: Blob, name: string, transcript?: string) => {
    setError(null);
    const type = blob.type.split(';')[0]!;
    if (!ACCEPTED.split(',').includes(type)) return setError(`"${name}": envie imagens (PNG, JPG, GIF, WebP) ou áudios.`);
    if (blob.size > MAX_FILE_BYTES) return setError(`"${name}" passa de 10 MB.`);
    if (itemsRef.current.length >= MAX_FILES) return setError(`No máximo ${MAX_FILES} anexos por mensagem.`);
    const data = await toBase64(blob);
    setItems((current) => [...current, { id: crypto.randomUUID(), name, type: blob.type, data, transcript, preview: URL.createObjectURL(blob) }]);
  };

  const remove = (id: string) =>
    setItems((current) => {
      const item = current.find((entry) => entry.id === id);
      if (item) URL.revokeObjectURL(item.preview);
      return current.filter((entry) => entry.id !== id);
    });

  const clear = () =>
    setItems((current) => {
      current.forEach((item) => URL.revokeObjectURL(item.preview));
      return [];
    });

  /** What goes to the server (without the previews). */
  const uploads = (): AttachmentUpload[] => items.map(({ name, type, data, transcript }) => ({ name, type, data, ...(transcript && { transcript }) }));

  return { items, error, setError, add, remove, clear, uploads };
}

export function AttachmentList({ items, onRemove }: { items: PendingAttachment[]; onRemove: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <ul className="mb-1.5 flex flex-wrap gap-2">
      {items.map((item) => (
        <li key={item.id} className="relative flex max-w-full items-center gap-2 rounded-md border border-border bg-surface p-1 pr-6">
          {item.type.startsWith('image/') ? (
            <img src={item.preview} alt={item.name} className="h-14 w-14 rounded object-cover" />
          ) : (
            <div className="min-w-0">
              <audio controls src={item.preview} className="h-8 max-w-56" />
              {item.transcript && <p className="mt-0.5 line-clamp-2 max-w-56 text-[11px] text-muted italic">“{item.transcript}”</p>}
            </div>
          )}
          <button
            type="button"
            onClick={() => onRemove(item.id)}
            className="absolute top-0.5 right-1 text-xs text-muted hover:text-red-300"
            title="Tirar este anexo"
            aria-label={`Tirar ${item.name}`}
          >
            ✕
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The browser's speech recognition (Chrome, Edge, Safari); not in TypeScript's DOM types. */
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}

function createRecognition(): Recognition | null {
  const constructor = (window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;
  if (!constructor) return null;
  const recognition = new constructor();
  recognition.lang = 'pt-BR';
  recognition.continuous = true;
  recognition.interimResults = false;
  return recognition;
}

const RECORDING_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

/**
 * Records a voice note with the microphone. While recording, the browser also transcribes it (when it can), so Órbi
 * reads what was said; the audio itself is kept with the conversation.
 */
export function RecordButton({ onRecorded, onError, disabled }: { onRecorded: (blob: Blob, name: string, transcript?: string) => void; onError: (message: string) => void; disabled?: boolean }) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [recording]);
  // Leaving the screen mid-recording releases the microphone.
  useEffect(() => () => stopRef.current?.(), []);

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      return onError('Este navegador não grava áudio aqui (abra o Studio por http://localhost ou https).');
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return onError('Sem acesso ao microfone: permita o microfone para este site no navegador.');
    }
    const mimeType = RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => event.data.size > 0 && chunks.push(event.data);

    const recognition = createRecognition();
    const said: string[] = [];
    let recognitionDone: Promise<void> = Promise.resolve();
    if (recognition) {
      recognitionDone = new Promise((resolve) => {
        recognition.onend = () => resolve();
        recognition.onerror = () => resolve();
      });
      recognition.onresult = (event) => {
        for (let index = event.resultIndex; index < event.results.length; index++) {
          const result = event.results[index]!;
          if (result.isFinal) said.push(result[0].transcript.trim());
        }
      };
      try {
        recognition.start();
      } catch {
        recognitionDone = Promise.resolve();
      }
    }

    const recorded = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
    recorder.start();
    setSeconds(0);
    setRecording(true);

    stopRef.current = () => {
      stopRef.current = null;
      setRecording(false);
      if (recorder.state !== 'inactive') recorder.stop();
      recognition?.stop();
      stream.getTracks().forEach((track) => track.stop());
      // The last words may arrive a moment after the stop.
      void Promise.all([recorded, Promise.race([recognitionDone, new Promise((resolve) => setTimeout(resolve, 2500))])]).then(() => {
        const type = (recorder.mimeType || mimeType || 'audio/webm').split(';')[0]!;
        const blob = new Blob(chunks, { type });
        if (blob.size === 0) return;
        const ext = type === 'audio/mp4' ? 'm4a' : type.split('/')[1];
        const stamp = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(/:/g, '-');
        onRecorded(blob, `audio-${stamp}.${ext}`, said.filter(Boolean).join(' ') || undefined);
      });
    };
  };

  if (recording) {
    return (
      <button
        type="button"
        onClick={() => stopRef.current?.()}
        className="flex items-center gap-1.5 rounded-md border border-red-400/60 px-2 py-1 text-xs text-red-300 hover:bg-red-500/10"
        title="Parar e anexar o áudio"
      >
        <span className="h-2 w-2 animate-pulse rounded-full bg-red-400" />
        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')} · Parar
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => void start()}
      disabled={disabled}
      className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:border-accent/60 hover:text-white disabled:opacity-50"
      title="Gravar um áudio (o navegador também transcreve o que você falar)"
    >
      🎤 Gravar
    </button>
  );
}
