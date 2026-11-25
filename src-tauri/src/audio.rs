//! Captura do áudio do PC (tudo que está tocando) via loopback do WASAPI.
//!
//! No Windows, o cpal ativa o modo loopback quando abrimos um stream de
//! ENTRADA em um dispositivo de SAÍDA. As amostras são convertidas para
//! estéreo 16 bits e enviadas ao front em pedaços de ~20 ms por um Channel
//! do Tauri. Lá, um AudioWorklet toca isso dentro da transmissão.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use serde::Serialize;
use std::sync::{mpsc, Mutex};
use std::thread;
use tauri::ipc::Channel;

#[derive(Default)]
pub struct AudioState {
    stop_tx: Mutex<Option<mpsc::Sender<()>>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioInfo {
    sample_rate: u32,
    device: String,
}

#[tauri::command]
pub fn start_system_audio(
    on_chunk: Channel<Vec<i16>>,
    state: tauri::State<'_, AudioState>,
) -> Result<AudioInfo, String> {
    stop_inner(&state);

    let (info_tx, info_rx) = mpsc::channel::<Result<AudioInfo, String>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();

    // O stream do cpal não pode trocar de thread, então ele vive nesta thread
    // até recebermos o sinal de parar.
    thread::spawn(move || match build_stream(on_chunk) {
        Ok((stream, info)) => {
            if let Err(e) = stream.play() {
                let _ = info_tx.send(Err(e.to_string()));
                return;
            }
            let _ = info_tx.send(Ok(info));
            let _ = stop_rx.recv();
            drop(stream);
        }
        Err(e) => {
            let _ = info_tx.send(Err(e));
        }
    });

    let info = info_rx.recv().map_err(|e| e.to_string())??;
    *state.stop_tx.lock().unwrap() = Some(stop_tx);
    Ok(info)
}

#[tauri::command]
pub fn stop_system_audio(state: tauri::State<'_, AudioState>) {
    stop_inner(&state);
}

fn stop_inner(state: &AudioState) {
    if let Some(tx) = state.stop_tx.lock().unwrap().take() {
        let _ = tx.send(());
    }
}

fn build_stream(ch: Channel<Vec<i16>>) -> Result<(cpal::Stream, AudioInfo), String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or("Nenhum dispositivo de saída de áudio encontrado")?;
    let name = device.name().unwrap_or_else(|_| "Saída padrão".into());

    let supported = device
        .default_output_config()
        .map_err(|e| format!("Não consegui ler o formato do áudio: {e}"))?;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let channels = config.channels as usize;
    let rate = config.sample_rate.0;
    // ~20 ms de áudio estéreo por envio
    let chunk = (rate as usize / 50) * 2;

    let err_fn = |e: cpal::StreamError| eprintln!("erro no áudio do PC: {e}");

    let stream = match format {
        SampleFormat::F32 => {
            let mut acc: Vec<i16> = Vec::with_capacity(chunk * 2);
            device.build_input_stream(
                &config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    push_frames(data, channels, &mut acc, chunk, &ch, |s| s)
                },
                err_fn,
                None,
            )
        }
        SampleFormat::I16 => {
            let mut acc: Vec<i16> = Vec::with_capacity(chunk * 2);
            device.build_input_stream(
                &config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    push_frames(data, channels, &mut acc, chunk, &ch, |s| s as f32 / 32768.0)
                },
                err_fn,
                None,
            )
        }
        other => return Err(format!("Formato de áudio não suportado: {other:?}")),
    }
    .map_err(|e| format!("Não consegui capturar o áudio do PC: {e}"))?;

    Ok((
        stream,
        AudioInfo {
            sample_rate: rate,
            device: name,
        },
    ))
}

/// Converte para estéreo i16 (pega os dois primeiros canais; mono vira estéreo)
/// e envia quando junta um pedaço completo.
fn push_frames<T: Copy>(
    data: &[T],
    channels: usize,
    acc: &mut Vec<i16>,
    chunk: usize,
    ch: &Channel<Vec<i16>>,
    to_f32: impl Fn(T) -> f32,
) {
    if channels == 0 {
        return;
    }
    for frame in data.chunks(channels) {
        let l = to_f32(frame[0]);
        let r = if frame.len() > 1 { to_f32(frame[1]) } else { l };
        acc.push(to_i16(l));
        acc.push(to_i16(r));
    }
    if acc.len() >= chunk {
        let out = std::mem::replace(acc, Vec::with_capacity(chunk * 2));
        let _ = ch.send(out);
    }
}

fn to_i16(x: f32) -> i16 {
    (x.clamp(-1.0, 1.0) * 32767.0) as i16
}
