from __future__ import annotations

import argparse
from collections import deque
import hashlib
import html
import json
import os
from pathlib import Path
import re
import select
import socket
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Deque, Dict, List, Optional, Tuple

try:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import x25519
    HAS_X25519 = True
except ImportError:
    HAS_X25519 = False
    serialization = None
    x25519 = None

try:
    from pynput import keyboard as pynput_kb
    HAS_PYNPUT = True
except ImportError:
    HAS_PYNPUT = False


LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 7200
FALLBACK_LISTEN_PORT = 7100
REMOTE_HOST = "144.217.189.239"
REMOTE_PORT = 7100
HTTP_HOST = "127.0.0.1"
HTTP_PORT = 18446
PROXY_BUILD = "proxy_03062026_auto_guard"
BOARD_STATE_URL = "http://127.0.0.1:18445/state"
BOARD_STATE_REFRESH_MS = 45
BOARD_STATE_TIMEOUT_SEC = 0.05
BUFFER_SIZE = 65536
MAX_MULTIPLY = 64
MAX_RING_SCENE_ID = 16
PROXY_CONTACT_MAX_COPIES = 64
PROXY_CONTACT_MAX_TARGETS = 4
PROXY_CONTACT_MAX_LADDER_MS = 160
PROXY_CONTACT_MAX_LADDER_STEPS = 8
PROXY_CONTACT_SCAN_INTERVAL_MS = 3
PROXY_CONTACT_SCAN_HORIZON_MS = 240
PROXY_CONTACT_SCAN_FIRE_AHEAD_MS = 225
PROXY_CONTACT_SCAN_KEY_TTL_MS = 260
PROXY_CONTACT_SCAN_GLOBAL_GAP_MS = 10
PROXY_CONTACT_SCAN_BURST_COOLDOWN_MS = 58
PROXY_CONTACT_SCAN_REARM_DELTA_MS = 24
PROXY_CONTACT_PREFIRE_LEAD_MS = 34
PROXY_CONTACT_SCHEDULE_REUSE_MS = 90
PROXY_CONTACT_POST_RESOLVE_INHIBIT_MS = 900
PROXY_AUTO_PUNCH_POST_SEND_INHIBIT_MS = 420
PROXY_AUTO_PUNCH_BUSY_GRACE_MS = 160
PROXY_CONTACT_SELF_STALE_MS = 2600
PROXY_CONTACT_TARGET_STALE_MS = 2200
PROXY_CONTACT_STATIC_POSE_STALE_MS = 520
PROXY_CONTACT_GRID_OFFSETS_MS = (0, 6, 12, 18, 26, 36, 50, 68, 92, 124, 164, 208, 240)
PROXY_CONTACT_LOOSE_TOLERANCE = 0.18
PROXY_MOVE_STEP_DEFAULT_MS = 550
PROXY_MOVE_STEP_MIN_MS = 80
PROXY_MOVE_STEP_MAX_MS = 1600
PROXY_ADAPTIVE_CONTACT_HORIZON_MAX_MS = 860
PROXY_ADAPTIVE_CONTACT_FIRE_MAX_MS = 820
PROXY_ADAPTIVE_RELEASE_HORIZON_MAX_MS = 360
PROXY_ADAPTIVE_RELEASE_FIRE_MAX_MS = 260
PROXY_RELEASE_SCAN_OFFSETS_MS = (0, 5, 10, 16, 24, 34, 46, 62, 82)
PROXY_RELEASE_PREARM_OFFSETS_MS = (-18, -10, -4, 0, 6, 14, 26, 42, 62)
PROXY_RELEASE_PREARM_MAX_MS = 170
PROXY_RELEASE_PREDICT_HORIZON_MS = 210
PROXY_RELEASE_FIRE_AHEAD_MS = 130
PROXY_RELEASE_RECENT_BUSY_MS = 520
PROXY_RELEASE_BUSY_STATES = {7, 8, 9, 10, 14}
PROXY_RELEASE_READY_STATES = {2, 3}
PACKET_BRAIN_SCAN_INTERVAL_MS = 16
PACKET_BRAIN_KEY_TTL_MS = 420
PACKET_BRAIN_EPISODE_HOLD_MS = 520
PACKET_BRAIN_EPISODE_RESET_MS = 180
PACKET_BRAIN_POST_RESOLVE_INHIBIT_MS = 900
PACKET_BRAIN_MAX_LADDER_MS = 220
PACKET_BRAIN_MAX_LADDER_STEPS = 8
PACKET_BRAIN_UP_MOVE_OFFSETS_MS = (0, 18, 42, 72, 112, 160)
PACKET_BRAIN_DOWN_MOVE_OFFSETS_MS = (0, 16, 32, 58, 92, 140, 200)
PACKET_BRAIN_QUIET_OFFSETS_MS = (0, 20, 44, 76, 120)
PRECONTACT_LEAD_MS = 72
PRECONTACT_SAMPLE_MS = 6
PRECONTACT_MIN_HOT_MS = 0
PRECONTACT_MAX_HOT_MS = 900
PRECONTACT_FIRE_MAX_ABS = 1.72
PRECONTACT_FIRE_MAX_LANE_GAP = 0.48

PUNCH_CHARCODE = 211
FRAME_START = 177
FRAME_END = 176
SEP = 179
HDR_END = 178

MOVE_DIR = {
    1: (1, 1),
    2: (-1, -1),
    3: (1, -1),
    4: (-1, 1),
    5: (1, 0),
    6: (0, -1),
    7: (0, 1),
    8: (-1, 0),
}

RSA_MODULUS_HEX = "9b50852c73378b3bab275d1a78d6e29b24ba43a1a15d207ef2e96acdc6c9d0c6dafdf6fef1200afde5f9e0d820a2399e62dba2fbb75ebd292a21df79b3549dd4a2d594da4c56d2f240261a06b6cafb33a6a37864ee75ebbb60be1b43af73fd814d9a36c6f95bdabd9554d3cec6de2473507fdbc78b32d8f6beacd578729edda1"
RSA_EXPONENT = 0x11
DH_PRIVATE_KEY_HEX = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
RSA_N = int(RSA_MODULUS_HEX, 16)


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def env_str(name: str, default: str) -> str:
    raw = os.environ.get(name)
    return raw if raw not in (None, "") else default


def sanitize_multiply(value: int) -> int:
    """Multiply means total punch frames sent per original upstream punch frame."""
    return max(1, min(MAX_MULTIPLY, int(value)))


def sanitize_delay_ms(value: object) -> int:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return 0
    return max(0, min(1000, parsed))


def sanitize_extra_copies(value: object) -> int:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return 0
    return max(0, min(MAX_MULTIPLY, parsed))


def sanitize_proxy_contact_copies(value: object) -> int:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return 1
    return max(1, min(PROXY_CONTACT_MAX_COPIES, parsed))


def sanitize_proxy_contact_targets(value: object) -> int:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return 1
    return max(1, min(PROXY_CONTACT_MAX_TARGETS, parsed))


def sanitize_proxy_contact_gap_ms(value: object) -> int:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return 0
    return max(0, min(120, parsed))


def sanitize_proxy_contact_ladder_ms(value: object) -> int:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return 0
    return max(0, min(PROXY_CONTACT_MAX_LADDER_MS, parsed))


def sanitize_proxy_contact_ladder_steps(value: object) -> int:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return 1
    return max(1, min(PROXY_CONTACT_MAX_LADDER_STEPS, parsed))


def sanitize_packet_brain_ladder_ms(value: object) -> int:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return 0
    return max(0, min(PACKET_BRAIN_MAX_LADDER_MS, parsed))


def sanitize_packet_brain_ladder_steps(value: object) -> int:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return 1
    return max(1, min(PACKET_BRAIN_MAX_LADDER_STEPS, parsed))


def sanitize_proxy_contact_axis(value: object) -> str:
    text = str(value or "").strip().lower().replace("-", "_")
    aliases = {
        "side": "both",
        "sides": "both",
        "dual": "both",
        "diag": "both",
        "diagonal": "both",
        "strict": "main",
        "classic": "main",
        "manhattan": "cardinal",
        "wide": "all",
    }
    text = aliases.get(text, text)
    return text if text in ("main", "mirror", "both", "cardinal", "all") else "both"


def parse_int_field(value: object, default: Optional[int] = None) -> Optional[int]:
    try:
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return default


def normalize_target_id(value: object) -> Optional[str]:
    if value in (None, ""):
        return None
    text = str(value).strip()
    if not text.isdigit():
        return None
    return text


def parse_bool(value: object) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "y", "on")
    return bool(value)


def tune_socket(sock: socket.socket, server_side: bool = False) -> None:
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 262144)
        if server_side:
            # Small send buffer to force immediate TCP flush for punches
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
        else:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 262144)
    except OSError:
        pass
    sock.setblocking(True)


class RC4:
    def __init__(self, key: bytes):
        self.S = list(range(256))
        j = 0
        for i in range(256):
            j = (j + self.S[i] + key[i % len(key)]) & 0xFF
            self.S[i], self.S[j] = self.S[j], self.S[i]
        self.i = 0
        self.j = 0

    def crypt(self, data: bytes) -> bytes:
        out = bytearray(len(data))
        for idx, value in enumerate(data):
            self.i = (self.i + 1) & 0xFF
            self.j = (self.j + self.S[self.i]) & 0xFF
            self.S[self.i], self.S[self.j] = self.S[self.j], self.S[self.i]
            k = self.S[(self.S[self.i] + self.S[self.j]) & 0xFF]
            out[idx] = value ^ k
        return bytes(out)


def rsa_public_decrypt(ciphertext_bytes: bytes) -> bytes:
    value = int.from_bytes(ciphertext_bytes, "big")
    plain = pow(value, RSA_EXPONENT, RSA_N)
    byte_len = max(1, (plain.bit_length() + 7) // 8)
    return plain.to_bytes(byte_len, "big")


def decode_rsa_decimal(plain_bytes: bytes) -> int:
    text = plain_bytes.decode("latin1", errors="ignore")
    matches = re.findall(r"\d+", text)
    if not matches:
        raise ValueError(f"RSA decimal payload not found in {plain_bytes[:32]!r}")
    # The actual DH values are the longest digit runs in the payload.
    digits = max(matches, key=len)
    return int(digits)


def parse_plaintext_frame(data: bytes) -> List[str]:
    fields: List[str] = []
    current = ""
    for value in data:
        if value == FRAME_START:
            current = ""
        elif value == HDR_END:
            fields.append(current)
            current = ""
        elif value == FRAME_END:
            if current:
                fields.append(current)
            current = ""
        elif value == SEP:
            continue
        else:
            current += chr(value)
    return fields


def extract_opcode(frame: bytes) -> Tuple[int, ...]:
    if len(frame) < 3 or frame[0] != FRAME_START:
        return ()
    opcode: List[int] = []
    idx = 1
    while idx < len(frame):
        value = frame[idx]
        if value == HDR_END:
            break
        if value != SEP:
            opcode.append(value)
        idx += 1
    return tuple(opcode)


def format_opcode(opcode: Tuple[int, ...]) -> str:
    if not opcode:
        return "[]"
    return "[" + ",".join(str(value) for value in opcode) + "]"


def split_complete_frames(buffer: bytearray) -> Tuple[bytes, List[bytes], bytearray]:
    flush_prefix = bytearray()
    frames: List[bytes] = []
    working = buffer
    while working:
        try:
            start = working.index(FRAME_START)
        except ValueError:
            flush_prefix.extend(working)
            return bytes(flush_prefix), frames, bytearray()
        if start > 0:
            flush_prefix.extend(working[:start])
            del working[:start]
        try:
            end = working.index(FRAME_END, 1)
        except ValueError:
            return bytes(flush_prefix), frames, bytearray(working)
        frames.append(bytes(working[: end + 1]))
        del working[: end + 1]
    return bytes(flush_prefix), frames, bytearray()


def build_punch_frame(target_id: object) -> bytes:
    target_str = normalize_target_id(target_id)
    if target_str is None:
        raise ValueError(f"invalid punch target id: {target_id!r}")
    payload = bytearray([FRAME_START, PUNCH_CHARCODE, SEP, HDR_END])
    payload.extend(target_str.encode("ascii"))
    payload.extend([SEP, HDR_END, FRAME_END])
    return bytes(payload)


def build_plaintext_frame(opcode: Tuple[int, ...], fields: List[str]) -> bytes:
    payload = bytearray([FRAME_START])
    for value in opcode:
        payload.append(int(value) & 0xFF)
        payload.append(SEP)
    payload.append(HDR_END)
    for field in fields:
        payload.extend(str(field).encode("iso-8859-1"))
        if str(field).find(chr(SEP)) < 0:
            payload.append(SEP)
        payload.append(HDR_END)
    payload.append(FRAME_END)
    return bytes(payload)


def is_punch_frame(frame: bytes) -> Tuple[bool, Optional[str]]:
    if len(frame) < 5 or frame[0] != FRAME_START or frame[-1] != FRAME_END:
        return False, None
    if frame[1] != PUNCH_CHARCODE:
        return False, None
    try:
        hdr_pos = frame.index(HDR_END)
    except ValueError:
        return False, None
    target = bytearray()
    idx = hdr_pos + 1
    while idx < len(frame) - 1:
        value = frame[idx]
        if value in (SEP, HDR_END, FRAME_END):
            break
        target.append(value)
        idx += 1
    try:
        return True, target.decode("ascii", errors="ignore")
    except UnicodeDecodeError:
        return False, None


def summarize_numeric(values: List[int]) -> Optional[Dict[str, float]]:
    if not values:
        return None
    ordered = sorted(int(v) for v in values)
    count = len(ordered)
    mid = count // 2
    if count % 2 == 1:
        median = float(ordered[mid])
    else:
        median = (ordered[mid - 1] + ordered[mid]) / 2.0
    avg = float(sum(ordered)) / float(count)
    return {
        "count": count,
        "min": int(ordered[0]),
        "max": int(ordered[-1]),
        "avg": round(avg, 2),
        "median": round(median, 2),
    }


def build_timing_sample_summary(samples: List[dict]) -> Dict[str, object]:
    correct = [item for item in samples if item.get("target_correct") is True]
    wrong = [item for item in samples if item.get("target_correct") is False]
    return {
        "samples": len(samples),
        "target_correct_samples": len(correct),
        "target_wrong_samples": len(wrong),
        "matched_latency_ms": summarize_numeric([item["matched_latency_ms"] for item in samples if item.get("matched_latency_ms") is not None]),
        "match_after_last_step_ms": summarize_numeric([item["match_after_last_relevant_step_ms"] for item in samples if item.get("match_after_last_relevant_step_ms") is not None]),
        "resolve_after_last_step_ms": summarize_numeric([item["resolve_after_last_relevant_step_ms"] for item in samples if item.get("resolve_after_last_relevant_step_ms") is not None]),
        "target_punches_after_last_step": summarize_numeric([item["target_punches_after_last_relevant_step"] for item in samples if item.get("target_punches_after_last_relevant_step") is not None]),
        "target_punch_count": summarize_numeric([item["target_punch_count"] for item in samples if item.get("target_punch_count") is not None]),
    }


def clean_offsets_from_samples(
    samples: List[dict],
    role: str,
    target_correct: Optional[bool] = None,
    cross_type: Optional[str] = None,
) -> List[int]:
    values: List[int] = []
    for item in samples:
        if item.get("role") != role:
            continue
        if target_correct is not None and item.get("target_correct") is not target_correct:
            continue
        if cross_type is not None and str(item.get("cross_type") or "unknown") != cross_type:
            continue
        value = item.get("match_after_last_relevant_step_ms")
        if value is None:
            continue
        value = int(value)
        if abs(value) > 250:
            continue
        values.append(value)
    return values


def timing_recommendation_from_offsets(
    atk_correct: List[int],
    def_correct: List[int],
    base_reason: str,
) -> Dict[str, object]:
    atk_summary = summarize_numeric(atk_correct)
    def_summary = summarize_numeric(def_correct)
    recommendation: Dict[str, object] = {
        "status": "insufficient_data",
        "reason": base_reason,
        "self_atk_offsets_ms": atk_summary,
        "self_def_offsets_ms": def_summary,
    }
    if not atk_correct and not def_correct:
        return recommendation
    if atk_correct and not def_correct:
        recommendation["status"] = "partial"
        recommendation["reason"] = "Only clean self_atk samples available."
    elif def_correct and not atk_correct:
        recommendation["status"] = "partial"
        recommendation["reason"] = "Only clean self_def samples available."
    else:
        recommendation["status"] = "ready"
        recommendation["reason"] = "Built from clean self_atk/self_def samples around the last relevant STEP_RX."
    preferred_center = int(round(sum(atk_correct) / len(atk_correct))) if atk_correct else int(round(sum(def_correct) / len(def_correct)))
    if atk_correct:
        preferred_from = min(atk_correct) - 12
        preferred_to = max(atk_correct) + 12
        if all(value <= 0 for value in atk_correct):
            preferred_to = min(preferred_to, 0)
    else:
        def_center = int(round(sum(def_correct) / len(def_correct)))
        preferred_from = def_center - 18
        preferred_to = def_center - 6
    if def_correct:
        def_floor = min(def_correct)
        if preferred_to >= def_floor:
            preferred_to = def_floor - 8
        if preferred_from >= preferred_to:
            preferred_from = preferred_to - 20
    recommendation.update(
        {
            "preferred_match_after_last_step_ms": {
                "from": int(preferred_from),
                "to": int(preferred_to),
                "center": int(preferred_center),
            },
            "interpretation": "Negative means punch before the last relevant STEP_RX. Positive means after it.",
            "hypothesis": (
                "Winning samples cluster before the last relevant STEP_RX."
                if atk_correct and all(value <= 0 for value in atk_correct)
                else "Winning samples do not yet isolate a purely pre-step window."
            ),
        }
    )
    return recommendation


def timing_recommendation_for_samples(samples: List[dict]) -> Dict[str, object]:
    atk_correct = clean_offsets_from_samples(samples, "self_atk", True)
    def_correct = clean_offsets_from_samples(samples, "self_def", True)
    return timing_recommendation_from_offsets(
        atk_correct,
        def_correct,
        "Need at least one clean self_atk and one clean self_def sample within +/-250ms of the last relevant STEP_RX.",
    )


def timing_recommendation_for_cross_type(samples: List[dict], cross_type: str) -> Dict[str, object]:
    atk_correct = clean_offsets_from_samples(samples, "self_atk", True, cross_type=cross_type)
    def_correct = clean_offsets_from_samples(samples, "self_def", True, cross_type=cross_type)
    return timing_recommendation_from_offsets(
        atk_correct,
        def_correct,
        f"Need clean self_atk/self_def samples for cross_type={cross_type} within +/-250ms of the last relevant STEP_RX.",
    )


def build_timing_analysis_from_samples(samples: List[dict]) -> Dict[str, object]:
    by_cross_type: Dict[str, object] = {}
    for cross_type in sorted({str(item.get("cross_type") or "unknown") for item in samples}):
        scoped = [item for item in samples if str(item.get("cross_type") or "unknown") == cross_type]
        by_cross_type[cross_type] = {
            "samples": len(scoped),
            "self_atk": build_timing_sample_summary([item for item in scoped if item.get("role") == "self_atk"]),
            "self_def": build_timing_sample_summary([item for item in scoped if item.get("role") == "self_def"]),
            "self_involved": build_timing_sample_summary([item for item in scoped if item.get("role") == "self_involved"]),
            "self_unmatched": build_timing_sample_summary([item for item in scoped if item.get("role") == "self_unmatched"]),
            "recommendation": timing_recommendation_for_cross_type(samples, cross_type),
        }
    return {
        "self_atk": build_timing_sample_summary([item for item in samples if item.get("role") == "self_atk"]),
        "self_def": build_timing_sample_summary([item for item in samples if item.get("role") == "self_def"]),
        "self_involved": build_timing_sample_summary([item for item in samples if item.get("role") == "self_involved"]),
        "self_unmatched": build_timing_sample_summary([item for item in samples if item.get("role") == "self_unmatched"]),
        "by_cross_type": by_cross_type,
        "recommendation": timing_recommendation_for_samples(samples),
    }


class HandshakeState:
    WAITING_INIT = 0
    WAITING_DH_PARAMS = 1
    WAITING_SERVER_PUB = 2
    DONE = 3
    PHASE_NAMES = {
        WAITING_INIT: "waiting_init",
        WAITING_DH_PARAMS: "waiting_dh_params",
        WAITING_SERVER_PUB: "waiting_server_pub",
        DONE: "done",
    }

    def __init__(self) -> None:
        self.phase = self.WAITING_INIT
        self.prime: Optional[int] = None
        self.generator: Optional[int] = None
        self.client_private = int(DH_PRIVATE_KEY_HEX, 16)
        self.client_public: Optional[int] = None
        self.server_public: Optional[int] = None
        self.shared_key_hex: Optional[str] = None
        self.rc4_key_bytes: Optional[bytes] = None

    @classmethod
    def phase_name(cls, phase: int) -> str:
        return cls.PHASE_NAMES.get(phase, f"unknown_{phase}")

    def debug_dict(self) -> dict:
        return {
            "phase": self.phase,
            "phase_name": self.phase_name(self.phase),
            "have_prime": self.prime is not None,
            "have_generator": self.generator is not None,
            "have_client_public": self.client_public is not None,
            "have_server_public": self.server_public is not None,
            "have_shared_key": self.shared_key_hex is not None,
            "rc4_key_ready": self.rc4_key_bytes is not None,
            "prime_bits": self.prime.bit_length() if self.prime is not None else 0,
            "server_public_bits": self.server_public.bit_length() if self.server_public is not None else 0,
            "shared_key_bytes": len(self.rc4_key_bytes) if self.rc4_key_bytes is not None else 0,
        }

    def process_client_frame(self, frame_data: bytes) -> None:
        opcode = extract_opcode(frame_data)
        fields = parse_plaintext_frame(frame_data)
        if opcode == (233, 34):
            self.phase = self.WAITING_DH_PARAMS
            return
        if self.phase == self.WAITING_DH_PARAMS and opcode in ((233, 36), (233, 38)):
            # Client public key/ack frame. Keep phase consistent even if
            # server params and client reply arrive tightly packed.
            self.phase = self.WAITING_SERVER_PUB
            return

    def process_server_frame(self, frame_data: bytes) -> None:
        opcode = extract_opcode(frame_data)
        fields = parse_plaintext_frame(frame_data)
        if not fields:
            return
        if self.phase == self.WAITING_DH_PARAMS and len(fields) >= 3 and opcode in ((230,), (233, 36)):
            prime_enc = bytes.fromhex(fields[1])
            gen_enc = bytes.fromhex(fields[2])
            prime_dec = rsa_public_decrypt(prime_enc)
            gen_dec = rsa_public_decrypt(gen_enc)
            self.prime = decode_rsa_decimal(prime_dec)
            self.generator = decode_rsa_decimal(gen_dec)
            self.client_public = pow(self.generator, self.client_private, self.prime)
            self.phase = self.WAITING_SERVER_PUB
            return
        if self.phase == self.WAITING_SERVER_PUB and len(fields) >= 2 and opcode in ((231,), (233, 38)):
            server_pub_enc = bytes.fromhex(fields[1])
            server_pub_dec = rsa_public_decrypt(server_pub_enc)
            self.server_public = decode_rsa_decimal(server_pub_dec)
            shared = pow(self.server_public, self.client_private, self.prime)
            self.shared_key_hex = format(shared, "x").upper()
            if len(self.shared_key_hex) % 2 == 1:
                self.shared_key_hex = "0" + self.shared_key_hex
            key_raw = bytes.fromhex(self.shared_key_hex)
            key_str = "".join(chr(value) for value in key_raw)
            self.rc4_key_bytes = key_str.encode("iso-8859-1")
            self.phase = self.DONE


@dataclass
class ProxyConfig:
    mode: str = "relay"
    listen_host: str = LISTEN_HOST
    listen_port: int = LISTEN_PORT
    remote_host: str = REMOTE_HOST
    remote_port: int = REMOTE_PORT
    http_host: str = HTTP_HOST
    http_port: int = HTTP_PORT
    multiply: int = 1
    verbose: bool = False
    flood: bool = False
    flood_interval: float = 0.0
    move_punch: bool = False
    move_punch_copies: int = 1
    move_punch_delay_ms: int = 0
    move_punch_spacing_ms: int = 0
    move_punch_target: str = ""
    step_punch: bool = False
    echo_punch: bool = False
    echo_punch_copies: int = 0
    echo_punch_delay_ms: int = 0
    echo_punch_spacing_ms: int = 0
    proxy_contact_counter: bool = False
    proxy_contact_copies: int = 1
    proxy_contact_targets: int = 1
    proxy_contact_min_gap_ms: int = 0
    proxy_contact_ladder_ms: int = 0
    proxy_contact_ladder_steps: int = 1
    proxy_contact_axis: str = "both"
    prequeue_punch: bool = False
    packet_brain: bool = False
    packet_brain_copies: int = 1
    packet_brain_targets: int = 2
    packet_brain_ladder_ms: int = 0
    packet_brain_ladder_steps: int = 1
    swf_key: bool = True
    detailed_events: bool = False
    live_historical: bool = False
    log_dir: str = "logs"


@dataclass
class SessionSnapshot:
    session_id: int
    client_addr: str
    started_at: float
    mode: str
    crypto_active: bool
    handshake_phase: int
    handshake_phase_name: str
    up_bytes: int
    down_bytes: int
    punches_seen: int
    punches_injected: int
    punches_total_sent: int
    effective_multiply: float
    flood_active: bool = False
    flood_punches: int = 0
    move_punch_active: bool = False
    move_punch_target: str = ""
    last_error: str = ""


@dataclass
class PunchSample:
    seq: int
    ts_ms: int
    target_id: str
    source: str
    copy_index: int
    copy_total: int
    move_attached: bool


class ProxyFileLogger:
    def __init__(self, root_dir: str):
        self.lock = threading.Lock()
        root = Path(root_dir)
        root.mkdir(parents=True, exist_ok=True)
        self.run_id = time.strftime("%Y%m%d_%H%M%S")
        self.run_dir = root / self.run_id
        self.sessions_dir = self.run_dir / "sessions"
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        self.proxy_log_path = self.run_dir / "proxy.log"
        self.events_log_path = self.run_dir / "events.jsonl"
        self._proxy_log = self.proxy_log_path.open("a", encoding="utf-8")
        self._events_log = self.events_log_path.open("a", encoding="utf-8")
        self._session_logs: Dict[int, object] = {}
        self._event_writes = 0
        self._last_event_flush = time.time()

    def write_proxy(self, message: str) -> None:
        line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}\n"
        with self.lock:
            self._proxy_log.write(line)
            self._proxy_log.flush()

    def write_session(self, session_id: int, message: str) -> None:
        line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}\n"
        with self.lock:
            handle = self._session_logs.get(session_id)
            if handle is None:
                path = self.sessions_dir / f"session_{session_id:03d}.log"
                handle = path.open("a", encoding="utf-8")
                self._session_logs[session_id] = handle
            handle.write(line)
            handle.flush()

    def write_event(self, event: dict) -> None:
        with self.lock:
            self._events_log.write(json.dumps(event, ensure_ascii=False) + "\n")
            self._event_writes += 1
            now = time.time()
            if self._event_writes >= 50 or now - self._last_event_flush >= 0.5:
                self._events_log.flush()
                self._event_writes = 0
                self._last_event_flush = now

    def close_session(self, session_id: int) -> None:
        with self.lock:
            handle = self._session_logs.pop(session_id, None)
            if handle is not None:
                handle.close()

    def close(self) -> None:
        with self.lock:
            for handle in self._session_logs.values():
                handle.close()
            self._session_logs.clear()
            self._events_log.flush()
            self._proxy_log.close()
            self._events_log.close()


class RosterMemoryStore:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        self.players: Dict[str, Dict[str, object]] = {}
        self.dirty = False
        self.last_save_at = 0.0
        self.save_interval_sec = 5.0
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        raw_players = payload.get("players", {})
        if isinstance(raw_players, dict):
            self.players = {str(key): dict(value) for key, value in raw_players.items() if isinstance(value, dict)}

    def _save_locked(self) -> None:
        payload = {"players": self.players}
        tmp_path = self.path.with_suffix(".tmp")
        tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp_path.replace(self.path)
        self.dirty = False
        self.last_save_at = time.time()

    def get(self, account_id: str) -> Optional[Dict[str, object]]:
        with self.lock:
            item = self.players.get(str(account_id))
            return dict(item) if item is not None else None

    def update_player(
        self,
        account_id: str,
        *,
        name: Optional[str] = None,
        skin_id: Optional[object] = None,
        scene_id: Optional[str] = None,
        member: Optional[object] = None,
    ) -> None:
        account_id = str(account_id)
        if not account_id or not account_id.isdigit():
            return
        changed = False
        with self.lock:
            entry = dict(self.players.get(account_id, {}))
            entry["account_id"] = account_id
            if name not in (None, "") and entry.get("name") != name:
                entry["name"] = name
                changed = True
            if skin_id not in (None, "") and entry.get("skin_id") != skin_id:
                entry["skin_id"] = skin_id
                changed = True
            if scene_id not in (None, "") and entry.get("last_scene_id") != scene_id:
                entry["last_scene_id"] = scene_id
                changed = True
            if member not in (None, "") and entry.get("member") != member:
                entry["member"] = member
                changed = True
            ts_ms = int(time.time() * 1000)
            if entry.get("last_seen_ts_ms") != ts_ms:
                entry["last_seen_ts_ms"] = ts_ms
                changed = True
            self.players[account_id] = entry
            if changed:
                self.dirty = True
                if time.time() - self.last_save_at >= self.save_interval_sec:
                    self._save_locked()


class ProxyRegistry:
    def __init__(self, config: ProxyConfig):
        self.config = config
        self.lock = threading.Lock()
        self.started_at = time.time()
        self.swf_remote_report_at = 0.0
        self.swf_remote_report = ""
        self.sessions: Dict[int, "ProxySession"] = {}
        self.next_session_id = 1
        self.event_log: List[dict] = []
        self.event_log_max = 500
        self.file_logger = ProxyFileLogger(config.log_dir)
        self.roster_memory = RosterMemoryStore(Path(__file__).resolve().parent / "data" / "roster-memory.json")
        self.historical_timing_cache: Optional[Dict[str, object]] = None
        self.historical_timing_cache_key = ""
        self.historical_timing_cache_at_ms = 0

    def apply_swf_remote(self, host: str, port: int) -> bool:
        host = str(host or "").strip()
        try:
            port = int(port)
        except (TypeError, ValueError):
            return False
        if not host or host in ("127.0.0.1", "localhost") or port <= 0 or port >= 65536:
            return False
        remote = f"{host}:{port}"
        with self.lock:
            self.config.remote_host = host
            self.config.remote_port = port
            self.swf_remote_report_at = time.time()
            self.swf_remote_report = remote
        line = f"[HTTP] SWF remote report {remote}"
        self.file_logger.write_proxy(line)
        print(line, flush=True)
        return True

    def apply_swf_rc4_key(self, key_hex: str) -> int:
        key_hex = str(key_hex or "").strip()
        if not re.fullmatch(r"[0-9a-fA-F]{64}", key_hex):
            line = "[HTTP] SWF RC4 key rejected"
            self.file_logger.write_proxy(line)
            print(line, flush=True)
            return 0
        key_bytes = bytes.fromhex(key_hex)
        applied = 0
        with self.lock:
            sessions = list(self.sessions.values())
        for session in sessions:
            if session.apply_swf_rc4_key(key_bytes):
                applied += 1
        line = f"[HTTP] SWF RC4 key applied sessions={applied}"
        self.file_logger.write_proxy(line)
        print(line, flush=True)
        return applied

    def wait_for_swf_remote_report(self, timeout_sec: float = 0.8) -> None:
        with self.lock:
            if self.swf_remote_report_at > 0:
                return
        deadline = time.time() + max(0.0, timeout_sec)
        while time.time() < deadline:
            with self.lock:
                if self.swf_remote_report_at > 0:
                    return
            time.sleep(0.025)

    def is_noisy_event(self, event: dict) -> bool:
        event_type = str(event.get("type") or "")
        if event_type in ("DOWN", "UP_MOVE", "PLAYER_MAP_CANDIDATE"):
            return True
        if event_type in ("MY_SCENE_ID_BOARD",):
            return True
        return False

    def add_event(self, event: dict) -> None:
        if not self.config.detailed_events and self.is_noisy_event(event):
            return
        with self.lock:
            event["ts"] = time.time()
            event["ts_ms"] = int(time.time() * 1000)
            self.event_log.append(event)
            while len(self.event_log) > self.event_log_max:
                self.event_log.pop(0)
        self.file_logger.write_event(event)

    def get_events(self, since_ms: int = 0) -> List[dict]:
        with self.lock:
            if since_ms <= 0:
                return list(self.event_log)
            return [e for e in self.event_log if e.get("ts_ms", 0) > since_ms]

    def allocate_session_id(self) -> int:
        with self.lock:
            session_id = self.next_session_id
            self.next_session_id += 1
            return session_id

    def add(self, session: "ProxySession") -> None:
        with self.lock:
            self.sessions[session.session_id] = session

    def remove(self, session_id: int) -> None:
        with self.lock:
            self.sessions.pop(session_id, None)
        self.file_logger.close_session(session_id)

    def apply_hub_self_scene(self, scene_id: object) -> bool:
        normalized = normalize_target_id(scene_id)
        if normalized is None or not ProxySession.is_probable_ring_scene_id(normalized):
            return False
        with self.lock:
            sessions = list(self.sessions.values())
        now_ms = int(time.time() * 1000)
        for session in sessions:
            changed = session.my_scene_id != normalized or session.my_scene_source != "hub_swf"
            session.my_scene_id = normalized
            session.my_scene_source = "hub_swf"
            session.ring_player_ids.add(normalized)
            entry = session._roster_entry(normalized)
            entry["board_is_self"] = True
            entry["last_seen_ts_ms"] = now_ms
            if changed:
                session.registry.add_event(
                    {
                        "type": "MY_SCENE_ID_HUB_SWF",
                        "scene_id": normalized,
                        "account_id": session.my_player_id or "?",
                    }
                )
        return True

    def apply_hub_entities(self, entities: object) -> int:
        if not isinstance(entities, list):
            return 0
        with self.lock:
            sessions = list(self.sessions.values())
        now_ms = int(time.time() * 1000)
        applied = 0
        for session in sessions:
            applied += session.apply_hub_entities(entities, now_ms)
        return applied

    def snapshots(self) -> Dict[str, object]:
        with self.lock:
            sessions = [session.snapshot() for session in self.sessions.values()]
            return {
                "config": {
                    "build": PROXY_BUILD,
                    "mode": self.config.mode,
                    "listen": f"{self.config.listen_host}:{self.config.listen_port}",
                    "remote": f"{self.config.remote_host}:{self.config.remote_port}",
                    "remote_host": self.config.remote_host,
                    "remote_port": self.config.remote_port,
                    "swf_remote_report": self.swf_remote_report,
                    "http": f"{self.config.http_host}:{self.config.http_port}",
                "multiply": self.config.multiply,
                "verbose": self.config.verbose,
                "detailed_events": self.config.detailed_events,
                "live_historical": self.config.live_historical,
                "move_punch": self.config.move_punch,
                "move_punch_copies": self.config.move_punch_copies,
                "move_punch_delay_ms": self.config.move_punch_delay_ms,
                "move_punch_spacing_ms": self.config.move_punch_spacing_ms,
                "move_punch_target": self.config.move_punch_target,
                "step_punch": self.config.step_punch,
                "echo_punch": self.config.echo_punch,
                "echo_punch_copies": self.config.echo_punch_copies,
                "echo_punch_delay_ms": self.config.echo_punch_delay_ms,
                "echo_punch_spacing_ms": self.config.echo_punch_spacing_ms,
                "proxy_contact_counter": self.config.proxy_contact_counter,
                "proxy_contact_copies": self.config.proxy_contact_copies,
                "proxy_contact_targets": self.config.proxy_contact_targets,
                "proxy_contact_min_gap_ms": self.config.proxy_contact_min_gap_ms,
                "proxy_contact_ladder_ms": self.config.proxy_contact_ladder_ms,
                "proxy_contact_ladder_steps": self.config.proxy_contact_ladder_steps,
                "proxy_contact_axis": self.config.proxy_contact_axis,
                "packet_brain": self.config.packet_brain,
                "packet_brain_copies": self.config.packet_brain_copies,
                "packet_brain_targets": self.config.packet_brain_targets,
                "packet_brain_ladder_ms": self.config.packet_brain_ladder_ms,
                "packet_brain_ladder_steps": self.config.packet_brain_ladder_steps,
                "swf_key": self.config.swf_key,
                "log_dir": str(self.file_logger.run_dir),
            },
                "activeSessions": [snapshot.__dict__ for snapshot in sessions],
            }

    def debug_payload(self) -> Dict[str, object]:
        with self.lock:
            sessions = [session.debug_snapshot() for session in self.sessions.values()]
            total_seen = sum(int(s["punch211"]["seen"]) for s in sessions)
            total_injected = sum(int(s["punch211"]["injected"]) for s in sessions)
            total_sent = sum(int(s["punch211"]["total_sent"]) for s in sessions)
            total_correlated = sum(int(s["punch211"]["correlated_resolves"]) for s in sessions)
            total_self_atk = sum(int(s["punch211"]["self_atk_matches"]) for s in sessions)
            total_self_def = sum(int(s["punch211"]["self_def_matches"]) for s in sessions)
            total_self_target_miss = sum(int(s["punch211"].get("self_target_miss_matches", 0)) for s in sessions)
            total_self_target_punches = sum(int(s["punch211"].get("self_target_punches", 0)) for s in sessions)
            total_target_only = sum(int(s["punch211"]["target_only_matches"]) for s in sessions)
            total_late = sum(int(s["punch211"]["late_matches"]) for s in sessions)
            total_pending = sum(int(s["punch211"]["pending"]) for s in sessions)
            total_proxy_contact_fires = sum(int(s.get("proxy_contact", {}).get("fires", 0)) for s in sessions)
            total_proxy_contact_skips = sum(int(s.get("proxy_contact", {}).get("skips", 0)) for s in sessions)
            total_proxy_contact_scan_fires = sum(int(s.get("proxy_contact", {}).get("scan_fires", 0)) for s in sessions)
            total_proxy_contact_scan_skips = sum(int(s.get("proxy_contact", {}).get("scan_skips", 0)) for s in sessions)
            total_proxy_release_fires = sum(int(s.get("proxy_release", {}).get("fires", 0)) for s in sessions)
            total_proxy_release_skips = sum(int(s.get("proxy_release", {}).get("skips", 0)) for s in sessions)
            total_packet_brain_fires = sum(int(s.get("packet_brain", {}).get("fires", 0)) for s in sessions)
            total_packet_brain_skips = sum(int(s.get("packet_brain", {}).get("skips", 0)) for s in sessions)
            movement_steps = [
                int(movement.get("step_ewma_ms"))
                for movement in (s.get("movement", {}) for s in sessions)
                if movement.get("step_ewma_ms") is not None
            ]
            movement_contact_horizons = [
                int(movement.get("contact_horizon_ms"))
                for movement in (s.get("movement", {}) for s in sessions)
                if movement.get("contact_horizon_ms") is not None
            ]
            crypto_sessions = sum(1 for s in sessions if s["crypto"]["active"])
            return {
                "config": {
                    "build": PROXY_BUILD,
                    "mode": self.config.mode,
                    "listen": f"{self.config.listen_host}:{self.config.listen_port}",
                    "remote": f"{self.config.remote_host}:{self.config.remote_port}",
                    "remote_host": self.config.remote_host,
                    "remote_port": self.config.remote_port,
                    "swf_remote_report": self.swf_remote_report,
                    "http": f"{self.config.http_host}:{self.config.http_port}",
                    "multiply": self.config.multiply,
                    "verbose": self.config.verbose,
                    "detailed_events": self.config.detailed_events,
                    "live_historical": self.config.live_historical,
                    "flood": self.config.flood,
                    "flood_interval": self.config.flood_interval,
                    "move_punch": self.config.move_punch,
                    "move_punch_copies": self.config.move_punch_copies,
                    "move_punch_delay_ms": self.config.move_punch_delay_ms,
                    "move_punch_spacing_ms": self.config.move_punch_spacing_ms,
                    "move_punch_target": self.config.move_punch_target,
                    "step_punch": self.config.step_punch,
                    "echo_punch": self.config.echo_punch,
                    "echo_punch_copies": self.config.echo_punch_copies,
                    "echo_punch_delay_ms": self.config.echo_punch_delay_ms,
                    "echo_punch_spacing_ms": self.config.echo_punch_spacing_ms,
                    "proxy_contact_counter": self.config.proxy_contact_counter,
                    "proxy_contact_copies": self.config.proxy_contact_copies,
                    "proxy_contact_targets": self.config.proxy_contact_targets,
                    "proxy_contact_min_gap_ms": self.config.proxy_contact_min_gap_ms,
                    "proxy_contact_ladder_ms": self.config.proxy_contact_ladder_ms,
                    "proxy_contact_ladder_steps": self.config.proxy_contact_ladder_steps,
                    "proxy_contact_axis": self.config.proxy_contact_axis,
                    "packet_brain": self.config.packet_brain,
                    "packet_brain_copies": self.config.packet_brain_copies,
                    "packet_brain_targets": self.config.packet_brain_targets,
                    "packet_brain_ladder_ms": self.config.packet_brain_ladder_ms,
                    "packet_brain_ladder_steps": self.config.packet_brain_ladder_steps,
                    "swf_key": self.config.swf_key,
                    "log_dir": str(self.file_logger.run_dir),
                },
                "summary": {
                    "active_sessions": len(sessions),
                    "crypto_sessions": crypto_sessions,
                    "punch211_seen": total_seen,
                    "punch211_injected": total_injected,
                    "punch211_total_sent": total_sent,
                    "punch211_correlated_resolves": total_correlated,
                    "punch211_self_atk_matches": total_self_atk,
                    "punch211_self_def_matches": total_self_def,
                    "punch211_self_target_miss_matches": total_self_target_miss,
                    "punch211_self_target_punches": total_self_target_punches,
                    "punch211_target_only_matches": total_target_only,
                    "punch211_late_matches": total_late,
                    "punch211_pending": total_pending,
                    "punch211_match_rate": round(total_correlated / total_sent, 4) if total_sent > 0 else 0.0,
                    "proxy_contact_counter_fires": total_proxy_contact_fires,
                    "proxy_contact_counter_skips": total_proxy_contact_skips,
                    "proxy_contact_scan_fires": total_proxy_contact_scan_fires,
                    "proxy_contact_scan_skips": total_proxy_contact_scan_skips,
                    "proxy_release_counter_fires": total_proxy_release_fires,
                    "proxy_release_counter_skips": total_proxy_release_skips,
                    "packet_brain_fires": total_packet_brain_fires,
                    "packet_brain_skips": total_packet_brain_skips,
                    "movement_step_ms": int(round(sum(movement_steps) / len(movement_steps))) if movement_steps else 0,
                    "movement_contact_horizon_ms": int(round(sum(movement_contact_horizons) / len(movement_contact_horizons))) if movement_contact_horizons else 0,
                },
                "sessions": sessions,
            }

    def historical_timing_analysis_snapshot(self) -> Dict[str, object]:
        root = self.file_logger.run_dir.parent
        now_ms = int(time.time() * 1000)
        paths = sorted(root.glob("*/events.jsonl"))
        cache_parts: List[str] = []
        for path in paths:
            try:
                stat = path.stat()
            except OSError:
                continue
            cache_parts.append(f"{path}:{stat.st_mtime_ns}:{stat.st_size}")
        cache_key = "|".join(cache_parts)
        if (
            self.historical_timing_cache is not None
            and self.historical_timing_cache_key == cache_key
            and now_ms - self.historical_timing_cache_at_ms <= 3000
        ):
            return dict(self.historical_timing_cache)
        samples: List[dict] = []
        run_ids: List[str] = []
        for path in paths:
            try:
                lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
            except OSError:
                continue
            run_ids.append(path.parent.name)
            for line in lines:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event.get("type") != "RESOLVE_CONTEXT":
                    continue
                samples.append(event)
        analysis = build_timing_analysis_from_samples(samples)
        analysis["runs"] = len(run_ids)
        analysis["event_count"] = len(samples)
        analysis["run_ids"] = run_ids[-12:]
        self.historical_timing_cache = analysis
        self.historical_timing_cache_key = cache_key
        self.historical_timing_cache_at_ms = now_ms
        return dict(analysis)

    def roster_payload(self) -> Dict[str, object]:
        with self.lock:
            sessions = [session.debug_snapshot() for session in self.sessions.values()]
            return {
                "config": {
                    "build": PROXY_BUILD,
                    "mode": self.config.mode,
                    "listen": f"{self.config.listen_host}:{self.config.listen_port}",
                    "remote": f"{self.config.remote_host}:{self.config.remote_port}",
                    "remote_host": self.config.remote_host,
                    "remote_port": self.config.remote_port,
                    "swf_remote_report": self.swf_remote_report,
                    "http": f"{self.config.http_host}:{self.config.http_port}",
                    "multiply": self.config.multiply,
                    "verbose": self.config.verbose,
                    "detailed_events": self.config.detailed_events,
                    "live_historical": self.config.live_historical,
                    "flood": self.config.flood,
                    "flood_interval": self.config.flood_interval,
                    "move_punch": self.config.move_punch,
                    "move_punch_copies": self.config.move_punch_copies,
                    "move_punch_delay_ms": self.config.move_punch_delay_ms,
                    "move_punch_spacing_ms": self.config.move_punch_spacing_ms,
                    "move_punch_target": self.config.move_punch_target,
                    "step_punch": self.config.step_punch,
                    "echo_punch": self.config.echo_punch,
                    "echo_punch_copies": self.config.echo_punch_copies,
                    "echo_punch_delay_ms": self.config.echo_punch_delay_ms,
                    "echo_punch_spacing_ms": self.config.echo_punch_spacing_ms,
                    "proxy_contact_counter": self.config.proxy_contact_counter,
                    "proxy_contact_copies": self.config.proxy_contact_copies,
                    "proxy_contact_targets": self.config.proxy_contact_targets,
                    "proxy_contact_min_gap_ms": self.config.proxy_contact_min_gap_ms,
                    "proxy_contact_ladder_ms": self.config.proxy_contact_ladder_ms,
                    "proxy_contact_ladder_steps": self.config.proxy_contact_ladder_steps,
                    "proxy_contact_axis": self.config.proxy_contact_axis,
                    "packet_brain": self.config.packet_brain,
                    "packet_brain_copies": self.config.packet_brain_copies,
                    "packet_brain_targets": self.config.packet_brain_targets,
                    "packet_brain_ladder_ms": self.config.packet_brain_ladder_ms,
                    "packet_brain_ladder_steps": self.config.packet_brain_ladder_steps,
                    "swf_key": self.config.swf_key,
                    "log_dir": str(self.file_logger.run_dir),
                },
                "sessions": [
                    {
                        "session": item["session"],
                        "roster": item.get("roster", {}),
                        "cross_taxonomy": item.get("cross_taxonomy", {}),
                    }
                    for item in sessions
                ],
            }


class ProxySession(threading.Thread):
    PUNCH_MATCH_WINDOW_MS = 1200
    PUNCH_LATE_WINDOW_MS = 2200
    MAX_PENDING_PUNCHES = 256
    MAX_MATCH_LOG = 24
    CONTEXT_KEEP_MS = 4000
    RESOLVE_CONTEXT_WINDOW_MS = 700
    RESOLVE_CONTEXT_MAX_EVENTS = 128
    LOW_LATENCY_DOWN_OPCODES = {
        (120, 121),
        (128, 122),
        (134,),
        (184, 120),
        (182,),
        (146,),
        (144,),
        (161,),
        (175,),
        (125, 120),
        (200, 122),
        (211,),
    }

    def __init__(self, session_id: int, config: ProxyConfig, registry: ProxyRegistry, client_sock: socket.socket, client_addr: Tuple[str, int]):
        super().__init__(daemon=True)
        self.session_id = session_id
        self.config = config
        self.registry = registry
        self.client_sock = client_sock
        self.client_addr = f"{client_addr[0]}:{client_addr[1]}"
        self.remote_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.started_at = time.time()
        self.handshake = HandshakeState()
        self.crypto_active = False
        self.client_decrypt: Optional[RC4] = None
        self.client_encrypt: Optional[RC4] = None
        self.server_encrypt: Optional[RC4] = None
        self.server_decrypt: Optional[RC4] = None
        self.precrypto_passthrough = False
        self.swf_key_pending = False
        self.swf_key_applied = False
        self.swf_key_up_backlog = bytearray()
        self.swf_key_down_backlog = bytearray()
        self.ecdh_private = None
        self.ecdh_public_hex: Optional[str] = None
        self.ecdh_client_public_hex: Optional[str] = None
        self.ecdh_server_public_hex: Optional[str] = None
        self.ecdh_client_key_bytes: Optional[bytes] = None
        self.ecdh_server_key_bytes: Optional[bytes] = None
        self.up_plain_buffer = bytearray()
        self.down_plain_buffer = bytearray()
        self.last_error = ""
        self.up_bytes = 0
        self.down_bytes = 0
        self.punches_seen = 0
        self.punches_injected = 0
        self.last_up_bytes = 0
        self.last_down_bytes = 0
        self.last_stats_at = self.started_at
        self.handshake_debug_client = 8
        self.handshake_debug_server = 12
        self.precrypto_up_chunks: List[dict] = []
        self.precrypto_down_chunks: List[dict] = []
        self.precrypto_up_frames: List[dict] = []
        self.precrypto_down_frames: List[dict] = []
        self.precrypto_up_frame_count = 0
        self.precrypto_down_frame_count = 0
        self.upstream_debug_budget = 24
        self.upstream_lock = threading.Lock()
        self.downstream_lock = threading.Lock()
        self._pending_downstream = bytearray()
        self.flood_target: Optional[str] = None
        self.flood_frame: Optional[bytes] = None
        self.flood_active = False
        self.flood_punches = 0
        self.flood_thread: Optional[threading.Thread] = None
        self.ring_player_ids: set = set()
        self.my_player_id: Optional[str] = None
        self.my_scene_id: Optional[str] = None
        self.my_scene_source = ""
        self.account_to_scene_id: Dict[str, str] = {}
        self.scene_to_account_id: Dict[str, str] = {}
        self.scene_roster: Dict[str, Dict[str, object]] = {}
        self.account_state_cache: Dict[str, Dict[str, object]] = {}
        self.pending_self_scene_candidate: Optional[Tuple[str, str, int]] = None
        self.hotkey_active = False
        self.hotkey_thread: Optional[threading.Thread] = None
        self.last_move_frame: Optional[bytes] = None
        self.last_move_punch_no_target_log_at = 0.0
        self.last_step_punch_no_target_log_at = 0.0
        self.proxy_contact_counter_fires = 0
        self.proxy_contact_counter_skips = 0
        self.proxy_contact_counter_last_fire_at_ms = 0
        self.proxy_contact_counter_last_key = ""
        self.proxy_contact_counter_last_target = ""
        self.proxy_contact_counter_last_reason = ""
        self.proxy_contact_counter_last_batch_ms = 0
        self.proxy_contact_counter_last_debug: Dict[str, object] = {}
        self.proxy_contact_scan_thread: Optional[threading.Thread] = None
        self.proxy_contact_scan_stop = False
        self.proxy_contact_scan_fires = 0
        self.proxy_contact_scan_skips = 0
        self.proxy_contact_scan_last_fire_at_ms = 0
        self.proxy_contact_scan_last_key = ""
        self.proxy_contact_scan_last_reason = ""
        self.proxy_contact_scan_last_debug: Dict[str, object] = {}
        self.proxy_contact_scan_last_key_at: Dict[str, int] = {}
        self.proxy_contact_scan_last_contact_in_by_key: Dict[str, int] = {}
        self.proxy_contact_scan_scheduled_at_by_key: Dict[str, int] = {}
        self.proxy_contact_scan_burst_until_ms = 0
        self.proxy_contact_burst_id = 0
        self.proxy_contact_inhibit_until_ms = 0
        self.proxy_release_counter_fires = 0
        self.proxy_release_counter_skips = 0
        self.proxy_release_counter_last_fire_at_ms = 0
        self.proxy_release_counter_last_reason = ""
        self.proxy_release_counter_last_debug: Dict[str, object] = {}
        self.proxy_release_counter_burst_id = 0
        self.proxy_release_counter_last_state = ""
        self.proxy_release_counter_last_state_at_ms = 0
        self.proxy_release_counter_last_arm_at_ms = 0
        self.proxy_release_counter_last_arm_key = ""
        self.packet_brain_fires = 0
        self.packet_brain_skips = 0
        self.packet_brain_last_fire_at_ms = 0
        self.packet_brain_last_quiet_scan_ms = 0
        self.packet_brain_last_key = ""
        self.packet_brain_last_target = ""
        self.packet_brain_last_reason = ""
        self.packet_brain_last_debug: Dict[str, object] = {}
        self.packet_brain_last_key_at: Dict[str, int] = {}
        self.packet_brain_episode_key = ""
        self.packet_brain_episode_until_ms = 0
        self.packet_brain_episode_seen_ms = 0
        self.packet_brain_burst_id = 0
        self.packet_brain_inhibit_until_ms = 0
        self.next_move_seq = 1
        self.punch_samples_lock = threading.Lock()
        self.next_punch_seq = 1
        self.pending_punches: List[PunchSample] = []
        self.recent_punch_matches: List[dict] = []
        self.resolve_matches = 0
        self.resolve_self_atk_matches = 0
        self.resolve_self_def_matches = 0
        self.resolve_self_target_miss_matches = 0
        self.resolve_target_only_matches = 0
        self.resolve_unknown_matches = 0
        self.resolve_mismatches = 0
        self.resolve_late_matches = 0
        self.expired_unmatched_punches = 0
        self.match_latency_total_ms = 0
        self.match_latency_count = 0
        self.match_latency_recent: List[int] = []
        self.recent_context_events: Deque[dict] = deque()
        self.self_target_punches = 0
        self.resolve_context_samples: List[dict] = []
        self.cross_taxonomy_samples: List[dict] = []
        self.last_board_sync_ms = 0
        self.move_step_ewma_ms = 0.0
        self.move_step_samples = 0
        self.move_step_min_ms = 0
        self.move_step_max_ms = 0
        self.move_step_last_ms = 0
        self.move_step_last_source = ""
        self.move_step_last_at_ms = 0
        # --- Contact V5: half-RTT tracking ---
        self.half_rtt_ms = 0
        self.half_rtt_ewma_ms = 0.0
        self.half_rtt_samples = 0
        self.half_rtt_last_ms = 0
        # --- Contact V5: direction history per target (for next-step prediction) ---
        self.target_direction_history: Dict[str, List[int]] = {}
        # --- Contact V6: pre-queue punch system ---
        self.prequeue_fires = 0
        self.prequeue_hits = 0
        self.prequeue_last_fire_ms = 0
        self.prequeue_last_target = ""
        self.prequeue_pending_key = ""  # dedup: "target:tile_x,tile_y" of scheduled prequeue
        self.prequeue_pending_until_ms = 0
        self.prequeue_copies = 2  # small, precise — not 64
        self.has_seen_ring_resolve = False  # gate: only fire in confirmed Ring

    def snapshot(self) -> SessionSnapshot:
        total_sent = self.punches_seen + self.punches_injected
        eff = float(total_sent) / float(self.punches_seen) if self.punches_seen > 0 else 0.0
        return SessionSnapshot(
            session_id=self.session_id,
            client_addr=self.client_addr,
            started_at=self.started_at,
            mode=self.config.mode,
            crypto_active=self.crypto_active,
            handshake_phase=self.handshake.phase,
            handshake_phase_name=self.handshake.phase_name(self.handshake.phase),
            up_bytes=self.up_bytes,
            down_bytes=self.down_bytes,
            punches_seen=self.punches_seen,
            punches_injected=self.punches_injected,
            punches_total_sent=total_sent,
            effective_multiply=round(eff, 2),
            flood_active=self.flood_active,
            flood_punches=self.flood_punches,
            move_punch_active=self.config.move_punch,
            move_punch_target=self.config.move_punch_target or self.flood_target or "",
            last_error=self.last_error,
        )

    def _observe_step_ms(self, step_ms: object, source: str) -> None:
        parsed = parse_int_field(step_ms)
        if parsed is None or parsed < PROXY_MOVE_STEP_MIN_MS or parsed > PROXY_MOVE_STEP_MAX_MS:
            return
        value = int(parsed)
        if self.move_step_samples <= 0:
            self.move_step_ewma_ms = float(value)
            self.move_step_min_ms = value
            self.move_step_max_ms = value
        else:
            # Contact V5: fast EWMA (alpha=0.45) + abrupt change detection
            if self.move_step_ewma_ms > 0 and abs(float(value) - self.move_step_ewma_ms) > self.move_step_ewma_ms * 0.15:
                # Server changed step speed abruptly — reset EWMA immediately
                self.move_step_ewma_ms = float(value)
                self.log(f"STEP_MS abrupt change detected: {value}ms (was {int(round(self.move_step_ewma_ms))}ms)", console=True)
            else:
                self.move_step_ewma_ms = self.move_step_ewma_ms * 0.55 + float(value) * 0.45
            self.move_step_min_ms = min(self.move_step_min_ms or value, value)
            self.move_step_max_ms = max(self.move_step_max_ms or value, value)
        self.move_step_samples += 1
        self.move_step_last_ms = value
        self.move_step_last_source = source
        self.move_step_last_at_ms = int(time.time() * 1000)

    def _movement_step_ms(self) -> int:
        if self.move_step_samples >= 2 and self.move_step_ewma_ms > 0:
            return max(PROXY_MOVE_STEP_MIN_MS, min(PROXY_MOVE_STEP_MAX_MS, int(round(self.move_step_ewma_ms))))
        return PROXY_MOVE_STEP_DEFAULT_MS

    # --- Contact V5: half-RTT measurement ---
    def _observe_half_rtt(self, match_latency_ms: int) -> None:
        """Estimate half_rtt from a punch→resolve round-trip measurement."""
        if match_latency_ms <= 0 or match_latency_ms > 5000:
            return
        half = max(1, match_latency_ms // 2)
        if self.half_rtt_samples <= 0:
            self.half_rtt_ewma_ms = float(half)
        else:
            self.half_rtt_ewma_ms = self.half_rtt_ewma_ms * 0.7 + float(half) * 0.3
        self.half_rtt_samples += 1
        self.half_rtt_last_ms = half
        self.half_rtt_ms = max(1, int(round(self.half_rtt_ewma_ms)))

    def _get_half_rtt_ms(self) -> int:
        """Return current best estimate of half-RTT in ms (0 if unknown)."""
        if self.half_rtt_samples >= 2 and self.half_rtt_ms > 0:
            return self.half_rtt_ms
        return 0

    def _adaptive_contact_horizon_ms(self) -> int:
        step_ms = self._movement_step_ms()
        return max(PROXY_CONTACT_SCAN_HORIZON_MS, min(PROXY_ADAPTIVE_CONTACT_HORIZON_MAX_MS, int(round(step_ms * 1.12))))

    def _adaptive_contact_fire_ahead_ms(self) -> int:
        step_ms = self._movement_step_ms()
        return max(PROXY_CONTACT_SCAN_FIRE_AHEAD_MS, min(PROXY_ADAPTIVE_CONTACT_FIRE_MAX_MS, int(round(step_ms * 1.05))))

    def _adaptive_release_horizon_ms(self) -> int:
        step_ms = self._movement_step_ms()
        return max(PROXY_RELEASE_PREDICT_HORIZON_MS, min(PROXY_ADAPTIVE_RELEASE_HORIZON_MAX_MS, int(round(step_ms * 0.46))))

    def _adaptive_release_fire_ahead_ms(self) -> int:
        step_ms = self._movement_step_ms()
        return max(PROXY_RELEASE_FIRE_AHEAD_MS, min(PROXY_ADAPTIVE_RELEASE_FIRE_MAX_MS, int(round(step_ms * 0.34))))

    def _adaptive_grid_offsets_ms(self, horizon_ms: int) -> List[int]:
        horizon = max(0, int(horizon_ms))
        offsets = {int(offset) for offset in PROXY_CONTACT_GRID_OFFSETS_MS if int(offset) <= horizon}
        for ratio in (0.55, 0.7, 0.85, 1.0):
            offsets.add(max(0, min(horizon, int(round(horizon * ratio)))))
        offsets.add(horizon)
        return sorted(offsets)

    def _proxy_contact_prefire_lead_ms(self) -> int:
        ladder_ms = sanitize_proxy_contact_ladder_ms(self.config.proxy_contact_ladder_ms)
        if ladder_ms <= 0:
            return PROXY_CONTACT_PREFIRE_LEAD_MS
        return max(PROXY_CONTACT_PREFIRE_LEAD_MS, min(128, int(round(float(ladder_ms) * 0.72 + 16.0))))

    def _proxy_contact_schedule_delay_ms(self, contact_in_ms: int) -> int:
        return max(0, int(contact_in_ms) - self._proxy_contact_prefire_lead_ms())

    def _proxy_contact_max_targets(self) -> int:
        return sanitize_proxy_contact_targets(self.config.proxy_contact_targets)

    def _packet_brain_max_targets(self) -> int:
        return sanitize_proxy_contact_targets(self.config.packet_brain_targets)

    def _contact_eta_ms_from_candidate(self, item: Dict[str, object]) -> int:
        contact = item.get("contact") if isinstance(item, dict) else None
        if not isinstance(contact, dict):
            return 0
        eta = parse_int_field(contact.get("contact_eta_ms"), None)
        if eta is None:
            eta = parse_int_field(contact.get("in_ms"), None)
        if eta is None:
            eta = parse_int_field(item.get("contact_eta_ms"), None)
        if eta is None:
            eta = parse_int_field(item.get("contact_in_ms"), 0)
        return max(0, int(eta or 0))

    def _fire_delay_ms_from_candidate(self, item: Dict[str, object]) -> int:
        contact = item.get("contact") if isinstance(item, dict) else None
        if isinstance(contact, dict):
            delay = parse_int_field(contact.get("fire_delay_ms"), None)
            if delay is not None:
                return max(0, int(delay))
        delay = parse_int_field(item.get("fire_delay_ms"), None)
        if delay is not None:
            return max(0, int(delay))
        return self._proxy_contact_schedule_delay_ms(self._contact_eta_ms_from_candidate(item))

    def _compatible_contact_candidates(
        self,
        candidates: List[Dict[str, object]],
        max_targets: int,
        fire_window_ms: int = 24,
    ) -> List[Dict[str, object]]:
        if not candidates:
            return []
        best = candidates[0]
        best_fire = self._fire_delay_ms_from_candidate(best)
        best_contact = best.get("contact") if isinstance(best.get("contact"), dict) else {}
        best_axis = str(best_contact.get("axis") or best.get("axis") or "")
        best_kind = str(best_contact.get("kind") or best.get("kind") or "")
        selected: List[Dict[str, object]] = []
        seen: set[str] = set()
        limit = max(1, min(PROXY_CONTACT_MAX_TARGETS, int(max_targets)))
        for item in candidates:
            target_id = normalize_target_id(item.get("id"))
            if target_id is None or target_id in seen or target_id == str(self.my_scene_id or ""):
                continue
            contact = item.get("contact") if isinstance(item.get("contact"), dict) else {}
            axis = str(contact.get("axis") or item.get("axis") or "")
            kind = str(contact.get("kind") or item.get("kind") or "")
            fire_delay = self._fire_delay_ms_from_candidate(item)
            if selected and abs(fire_delay - best_fire) > int(fire_window_ms):
                continue
            if selected and best_axis and axis and axis != best_axis:
                continue
            if selected and best_kind.startswith("precontact") and kind and not kind.startswith(("precontact", "instant", "sweep")):
                continue
            selected.append(item)
            seen.add(target_id)
            if len(selected) >= limit:
                break
        return selected

    def movement_debug_snapshot(self) -> Dict[str, object]:
        now_ms = int(time.time() * 1000)
        return {
            "step_ewma_ms": int(round(self.move_step_ewma_ms)) if self.move_step_samples > 0 else None,
            "samples": self.move_step_samples,
            "last_step_ms": self.move_step_last_ms or None,
            "min_step_ms": self.move_step_min_ms or None,
            "max_step_ms": self.move_step_max_ms or None,
            "last_source": self.move_step_last_source,
            "last_age_ms": max(0, now_ms - self.move_step_last_at_ms) if self.move_step_last_at_ms else None,
            "contact_horizon_ms": self._adaptive_contact_horizon_ms(),
            "contact_fire_ahead_ms": self._adaptive_contact_fire_ahead_ms(),
            "contact_prefire_lead_ms": self._proxy_contact_prefire_lead_ms(),
            "release_horizon_ms": self._adaptive_release_horizon_ms(),
            "release_fire_ahead_ms": self._adaptive_release_fire_ahead_ms(),
            # Contact V5: half-RTT info
            "half_rtt_ms": self._get_half_rtt_ms(),
            "half_rtt_samples": self.half_rtt_samples,
            "half_rtt_last_ms": self.half_rtt_last_ms if self.half_rtt_samples > 0 else None,
            # Contact V6: pre-queue info
            "prequeue_fires": self.prequeue_fires,
            "prequeue_last_target": self.prequeue_last_target or None,
        }

    def debug_snapshot(self) -> Dict[str, object]:
        total_sent = self.punches_seen + self.punches_injected
        eff = float(total_sent) / float(self.punches_seen) if self.punches_seen > 0 else 0.0
        punch_debug = self.punch_debug_snapshot()
        roster_players = self.roster_snapshot()
        roster_combatants = self.combatant_snapshot()
        scene_ids_seen = [
            value
            for value in self.ring_player_ids
            if self.is_probable_ring_scene_id(str(value))
        ]
        return {
            "session": {
                "id": self.session_id,
                "client_addr": self.client_addr,
                "started_at": self.started_at,
                "mode": self.config.mode,
                "last_error": self.last_error,
                "my_account_id": self.my_player_id,
                "my_scene_id": self.my_scene_id,
                "my_scene_source": self.my_scene_source,
                "scene_ids_seen": sorted(scene_ids_seen, key=lambda value: int(value) if str(value).isdigit() else str(value)),
            },
            "handshake": self.handshake.debug_dict(),
            "crypto": {
                "active": self.crypto_active,
                "swf_key_pending": self.swf_key_pending,
                "swf_key_applied": self.swf_key_applied,
                "swf_key_up_backlog": len(self.swf_key_up_backlog),
                "swf_key_down_backlog": len(self.swf_key_down_backlog),
                "client_decrypt_ready": self.client_decrypt is not None,
                "client_encrypt_ready": self.client_encrypt is not None,
                "server_encrypt_ready": self.server_encrypt is not None,
                "server_decrypt_ready": self.server_decrypt is not None,
                "ecdh": {
                    "available": HAS_X25519,
                    "client_public_seen": self.ecdh_client_public_hex is not None,
                    "server_public_seen": self.ecdh_server_public_hex is not None,
                    "client_key_ready": self.ecdh_client_key_bytes is not None,
                    "server_key_ready": self.ecdh_server_key_bytes is not None,
                },
            },
            "traffic": {
                "up_bytes": self.up_bytes,
                "down_bytes": self.down_bytes,
            },
            "precrypto": {
                "passthrough": self.precrypto_passthrough,
                "up_chunks": self.precrypto_up_chunks,
                "down_chunks": self.precrypto_down_chunks,
                "up_frame_count": self.precrypto_up_frame_count,
                "down_frame_count": self.precrypto_down_frame_count,
                "up_frames": self.precrypto_up_frames,
                "down_frames": self.precrypto_down_frames,
            },
            "movement": self.movement_debug_snapshot(),
            "punch211": {
                "seen": self.punches_seen,
                "injected": self.punches_injected,
                "total_sent": total_sent,
                "effective_multiply": round(eff, 2),
                "flood_active": self.flood_active,
                "flood_punches": self.flood_punches,
                "flood_target": self.flood_target,
                "move_punch_enabled": self.config.move_punch,
                "move_punch_copies": self.config.move_punch_copies,
                "move_punch_delay_ms": self.config.move_punch_delay_ms,
                "move_punch_target": self.config.move_punch_target or self.flood_target or "",
                "step_punch_enabled": self.config.step_punch,
                "correlated_resolves": punch_debug["correlated_resolves"],
                "self_atk_matches": punch_debug["self_atk_matches"],
                "self_def_matches": punch_debug["self_def_matches"],
                "self_target_miss_matches": punch_debug["self_target_miss_matches"],
                "self_target_punches": punch_debug["self_target_punches"],
                "target_only_matches": punch_debug["target_only_matches"],
                "unknown_matches": punch_debug["unknown_matches"],
                "late_matches": punch_debug["late_matches"],
                "mismatches": punch_debug["mismatches"],
                "expired_unmatched": punch_debug["expired_unmatched"],
                "pending": punch_debug["pending"],
                "match_rate": punch_debug["match_rate"],
                "avg_match_latency_ms": punch_debug["avg_match_latency_ms"],
                "recent_matches": punch_debug["recent_matches"],
            },
            "proxy_contact": {
                "enabled": self.config.proxy_contact_counter,
                "copies": self.config.proxy_contact_copies,
                "targets": self.config.proxy_contact_targets,
                "min_gap_ms": self.config.proxy_contact_min_gap_ms,
                "ladder_ms": self.config.proxy_contact_ladder_ms,
                "ladder_steps": self.config.proxy_contact_ladder_steps,
                "axis_mode": self.config.proxy_contact_axis,
                "fires": self.proxy_contact_counter_fires,
                "skips": self.proxy_contact_counter_skips,
                "last_target": self.proxy_contact_counter_last_target,
                "last_reason": self.proxy_contact_counter_last_reason,
                "last_fire_age_ms": max(0, int(time.time() * 1000) - self.proxy_contact_counter_last_fire_at_ms) if self.proxy_contact_counter_last_fire_at_ms else None,
                "last_debug": self.proxy_contact_counter_last_debug,
                "scan_fires": self.proxy_contact_scan_fires,
                "scan_skips": self.proxy_contact_scan_skips,
                "scan_last_reason": self.proxy_contact_scan_last_reason,
                "scan_last_fire_age_ms": max(0, int(time.time() * 1000) - self.proxy_contact_scan_last_fire_at_ms) if self.proxy_contact_scan_last_fire_at_ms else None,
                "scan_last_debug": self.proxy_contact_scan_last_debug,
            },
            "proxy_release": {
                "enabled": self.config.proxy_contact_counter,
                "fires": self.proxy_release_counter_fires,
                "skips": self.proxy_release_counter_skips,
                "last_reason": self.proxy_release_counter_last_reason,
                "last_fire_age_ms": max(0, int(time.time() * 1000) - self.proxy_release_counter_last_fire_at_ms) if self.proxy_release_counter_last_fire_at_ms else None,
                "last_state": self.proxy_release_counter_last_state,
                "last_debug": self.proxy_release_counter_last_debug,
            },
            "packet_brain": {
                "enabled": self.config.packet_brain,
                "copies": self.config.packet_brain_copies,
                "targets": self.config.packet_brain_targets,
                "ladder_ms": self.config.packet_brain_ladder_ms,
                "ladder_steps": self.config.packet_brain_ladder_steps,
                "fires": self.packet_brain_fires,
                "skips": self.packet_brain_skips,
                "last_target": self.packet_brain_last_target,
                "last_reason": self.packet_brain_last_reason,
                "last_fire_age_ms": max(0, int(time.time() * 1000) - self.packet_brain_last_fire_at_ms) if self.packet_brain_last_fire_at_ms else None,
                "episode_until_ms": max(0, self.packet_brain_episode_until_ms - int(time.time() * 1000)) if self.packet_brain_episode_until_ms else 0,
                "inhibit_until_ms": max(0, self.packet_brain_inhibit_until_ms - int(time.time() * 1000)) if self.packet_brain_inhibit_until_ms else 0,
                "last_debug": self.packet_brain_last_debug,
            },
            "roster": {
                "count": len(roster_players),
                "players": roster_players,
                "combatants": roster_combatants,
            },
            "timing_analysis": punch_debug["timing_analysis"],
            "cross_taxonomy": self.cross_taxonomy_snapshot(),
        }

    def punch_debug_snapshot(self) -> Dict[str, object]:
        now_ms = int(time.time() * 1000)
        with self.punch_samples_lock:
            self._expire_pending_punches(now_ms)
            total_sent = self.punches_seen + self.punches_injected
            avg_latency = round(self.match_latency_total_ms / self.match_latency_count, 2) if self.match_latency_count > 0 else None
            match_rate = round(self.resolve_matches / total_sent, 4) if total_sent > 0 else 0.0
            recent_matches = list(self.recent_punch_matches)
            pending = len(self.pending_punches)
        return {
            "correlated_resolves": self.resolve_matches,
            "self_atk_matches": self.resolve_self_atk_matches,
            "self_def_matches": self.resolve_self_def_matches,
            "self_target_miss_matches": self.resolve_self_target_miss_matches,
            "target_only_matches": self.resolve_target_only_matches,
            "unknown_matches": self.resolve_unknown_matches,
            "late_matches": self.resolve_late_matches,
            "self_target_punches": self.self_target_punches,
            "mismatches": self.resolve_mismatches,
            "expired_unmatched": self.expired_unmatched_punches,
            "pending": pending,
            "match_rate": match_rate,
            "avg_match_latency_ms": avg_latency,
            "recent_matches": recent_matches,
            "timing_analysis": self.timing_analysis_snapshot(),
        }

    def timing_analysis_snapshot(self) -> Dict[str, object]:
        analysis = build_timing_analysis_from_samples(self.resolve_context_samples)
        analysis["cross_taxonomy"] = self.cross_taxonomy_snapshot()
        if self.config.live_historical:
            analysis["historical"] = self.registry.historical_timing_analysis_snapshot()
        return analysis

    def _clean_offsets(
        self,
        role: str,
        target_correct: Optional[bool] = None,
        cross_type: Optional[str] = None,
    ) -> List[int]:
        return clean_offsets_from_samples(self.resolve_context_samples, role, target_correct, cross_type)

    def _timing_recommendation_from_offsets(
        self,
        atk_correct: List[int],
        def_correct: List[int],
        base_reason: str,
    ) -> Dict[str, object]:
        return timing_recommendation_from_offsets(atk_correct, def_correct, base_reason)

    def timing_recommendation_snapshot(self) -> Dict[str, object]:
        return timing_recommendation_for_samples(self.resolve_context_samples)

    def _timing_recommendation_for_cross_type(self, cross_type: str) -> Dict[str, object]:
        return timing_recommendation_for_cross_type(self.resolve_context_samples, cross_type)

    def _record_punch_send(
        self,
        target_id: Optional[str],
        source: str,
        copy_index: int,
        copy_total: int,
        move_attached: bool,
    ) -> None:
        if not target_id:
            return
        now_ms = int(time.time() * 1000)
        with self.punch_samples_lock:
            self._expire_pending_punches(now_ms)
            sample = PunchSample(
                seq=self.next_punch_seq,
                ts_ms=now_ms,
                target_id=target_id,
                source=source,
                copy_index=copy_index,
                copy_total=copy_total,
                move_attached=move_attached,
            )
            self.next_punch_seq += 1
            self.pending_punches.append(sample)
            while len(self.pending_punches) > self.MAX_PENDING_PUNCHES:
                self.pending_punches.pop(0)
                self.expired_unmatched_punches += 1
        self_target = bool(self.my_scene_id) and str(target_id) == str(self.my_scene_id)
        if self_target:
            self.self_target_punches += 1
        self.registry.add_event(
            {
                "type": "UP_PUNCH",
                "session_id": self.session_id,
                "seq": sample.seq,
                "target_id": target_id,
                "source": source,
                "copy_index": copy_index,
                "copy_total": copy_total,
                "move_attached": move_attached,
                "my_id": self.my_player_id or "?",
                "my_scene_id": self.my_scene_id or "?",
                "self_target": self_target,
            }
        )
        self.record_context_event(
            {
                "kind": "UP_PUNCH",
                "seq": sample.seq,
                "target_id": target_id,
                "source": source,
                "copy_index": copy_index,
                "copy_total": copy_total,
                "move_attached": move_attached,
                "my_scene_id": self.my_scene_id or "?",
                "self_target": self_target,
            },
            now_ms,
        )
        if self_target:
            self.registry.add_event(
                {
                    "type": "SELF_TARGET_PUNCH",
                    "session_id": self.session_id,
                    "seq": sample.seq,
                    "target_id": target_id,
                    "my_scene_id": self.my_scene_id or "?",
                }
            )

    def _record_move_send(self, frame: bytes) -> None:
        now_ms = int(time.time() * 1000)
        fields = parse_plaintext_frame(frame)
        seq = self.next_move_seq
        self.next_move_seq += 1
        path_payload = fields[1] if len(fields) > 1 else ""
        hash_payload = fields[2] if len(fields) > 2 else ""
        event = {
            "type": "UP_MOVE",
            "session_id": self.session_id,
            "seq": seq,
            "fields_preview": fields[:8],
            "path_payload": path_payload,
            "hash_payload": hash_payload,
            "my_id": self.my_player_id or "?",
            "my_scene_id": self.my_scene_id or "?",
        }
        self.registry.add_event(event)
        self.record_context_event(
            {
                "kind": "UP_MOVE",
                "seq": seq,
                "fields": fields[1:8],
                "path_payload": path_payload,
                "hash_payload": hash_payload,
                "my_scene_id": self.my_scene_id or "?",
            },
            now_ms,
        )

    def _expire_pending_punches(self, now_ms: int) -> None:
        while self.pending_punches and (now_ms - self.pending_punches[0].ts_ms) > self.PUNCH_LATE_WINDOW_MS:
            self.pending_punches.pop(0)
            self.expired_unmatched_punches += 1

    def record_context_event(self, event: dict, ts_ms: Optional[int] = None) -> None:
        stamp = int(time.time() * 1000) if ts_ms is None else int(ts_ms)
        payload = dict(event)
        payload["ts_ms"] = stamp
        self.recent_context_events.append(payload)
        cutoff = stamp - self.CONTEXT_KEEP_MS
        while self.recent_context_events and self.recent_context_events[0].get("ts_ms", 0) < cutoff:
            self.recent_context_events.popleft()
        while len(self.recent_context_events) > 512:
            self.recent_context_events.popleft()

    @staticmethod
    def _step_xy(step: Optional[dict]) -> Optional[Tuple[int, int]]:
        if step is None:
            return None
        try:
            return int(step["x"]), int(step["y"])
        except (KeyError, TypeError, ValueError):
            return None

    @staticmethod
    def _diag_pair(a: Optional[Tuple[int, int]], b: Optional[Tuple[int, int]]) -> bool:
        if a is None or b is None:
            return False
        return abs(a[0] - b[0]) == 1 and abs(a[1] - b[1]) == 1

    @staticmethod
    def _stage_pair(a: Optional[Tuple[int, int]], b: Optional[Tuple[int, int]]) -> bool:
        if a is None or b is None:
            return False
        return abs(a[0] - b[0]) == 2 and abs(a[1] - b[1]) == 2

    @staticmethod
    def _cross_pass(prev_self: Optional[Tuple[int, int]], prev_opp: Optional[Tuple[int, int]], curr_self: Optional[Tuple[int, int]], curr_opp: Optional[Tuple[int, int]]) -> bool:
        if prev_self is None or prev_opp is None or curr_self is None or curr_opp is None:
            return False
        return prev_self == curr_opp and prev_opp == curr_self

    @staticmethod
    def _safe_xy(x_value: object, y_value: object) -> Optional[Tuple[int, int]]:
        try:
            return int(str(x_value)), int(str(y_value))
        except (TypeError, ValueError):
            return None

    def _recent_state146_events(self, window_events: List[dict], now_ms: int) -> List[dict]:
        items: List[dict] = []
        for item in reversed(window_events):
            if item.get("kind") != "DOWN_OPCODE":
                continue
            opcode = item.get("opcode")
            if opcode not in ([146], (146,)):
                continue
            fields = item.get("fields") or []
            if len(fields) < 4:
                continue
            account_id = str(fields[0])
            items.append(
                {
                    "account_id": account_id,
                    "mapped_scene_id": str(self.account_to_scene_id.get(account_id) or ""),
                    "state_code": str(fields[1]),
                    "state_arg1": str(fields[2]),
                    "state_arg2": str(fields[3]),
                    "ts_ms": int(item.get("ts_ms", 0)),
                    "delta_ms": max(0, now_ms - int(item.get("ts_ms", 0))),
                }
            )
            if len(items) >= 2:
                break
        items.reverse()
        return items

    def _classify_cross_taxonomy(
        self,
        my_scene_id: str,
        opponent_id: str,
        parsed_steps: List[dict],
        last_self_step: Optional[dict],
        last_opponent_step: Optional[dict],
        resolve_self_xy: Optional[Tuple[int, int]] = None,
        resolve_opp_xy: Optional[Tuple[int, int]] = None,
    ) -> Dict[str, object]:
        prev_self_step = next(
            (item for item in reversed(parsed_steps) if item["entity_id"] == my_scene_id and last_self_step is not None and item["ts_ms"] < last_self_step["ts_ms"]),
            None,
        )
        prev_opponent_step = next(
            (item for item in reversed(parsed_steps) if item["entity_id"] == opponent_id and last_opponent_step is not None and item["ts_ms"] < last_opponent_step["ts_ms"]),
            None,
        )
        curr_self = self._step_xy(last_self_step) or resolve_self_xy
        curr_opp = self._step_xy(last_opponent_step) or resolve_opp_xy
        prev_self = self._step_xy(prev_self_step)
        prev_opp = self._step_xy(prev_opponent_step)
        self_moved = last_self_step is not None
        opp_moved = last_opponent_step is not None
        both_moved = self_moved and opp_moved and abs(int(last_self_step["ts_ms"]) - int(last_opponent_step["ts_ms"])) <= 160
        curr_diag = self._diag_pair(curr_self, curr_opp)
        prev_stage = self._stage_pair(prev_self, prev_opp)
        curr_stage = self._stage_pair(curr_self, curr_opp)
        swapped = self._cross_pass(prev_self, prev_opp, curr_self, curr_opp)
        cross_type = "unknown"
        tags: List[str] = []
        if swapped:
            cross_type = "cross_pass"
            tags.append("swap")
        elif prev_stage and curr_diag:
            cross_type = "stage_to_diag"
            tags.append("compress")
        elif both_moved and curr_diag:
            cross_type = "both_in"
            tags.append("dual_step")
        elif opp_moved and not self_moved and (curr_diag or curr_stage):
            cross_type = "enemy_in_to_me"
            tags.append("enemy_step")
        elif self_moved and not opp_moved and (curr_diag or curr_stage):
            cross_type = "self_in_to_enemy"
            tags.append("self_step")
        elif opp_moved and self_moved and curr_stage:
            cross_type = "both_in"
            tags.append("stage_close")
        meta = {
            "cross_type": cross_type,
            "cross_tags": tags,
            "curr_self": curr_self,
            "curr_opp": curr_opp,
            "prev_self": prev_self,
            "prev_opp": prev_opp,
            "curr_diag": curr_diag,
            "curr_stage": curr_stage,
            "prev_stage": prev_stage,
            "swapped": swapped,
            "both_moved": both_moved,
        }
        return meta

    def cross_taxonomy_snapshot(self) -> Dict[str, object]:
        counts: Dict[str, int] = {}
        by_role: Dict[str, Dict[str, int]] = {}
        for item in self.cross_taxonomy_samples:
            cross_type = str(item.get("cross_type") or "unknown")
            role = str(item.get("role") or "unknown")
            counts[cross_type] = counts.get(cross_type, 0) + 1
            role_counts = by_role.setdefault(role, {})
            role_counts[cross_type] = role_counts.get(cross_type, 0) + 1
        return {
            "samples": len(self.cross_taxonomy_samples),
            "counts": counts,
            "by_role": by_role,
            "recent": self.cross_taxonomy_samples[-12:],
        }

    def emit_resolve_context(self, evt: dict, match: dict, now_ms: int) -> None:
        role = match.get("role")
        if role not in ("self_atk", "self_def", "self_involved", "self_unmatched"):
            return
        start_ms = now_ms - self.RESOLVE_CONTEXT_WINDOW_MS
        atk_id = str(evt.get("atk_id", ""))
        def_id = str(evt.get("def_id", ""))
        my_scene_id = str(self.my_scene_id or "")
        opponent_id = str(def_id if atk_id == my_scene_id else atk_id if def_id == my_scene_id else (match.get("target_id") or ""))
        target_id = str(match.get("target_id") or opponent_id)
        matched_latency_raw = match.get("latency_ms")
        matched_latency_ms = int(matched_latency_raw) if matched_latency_raw is not None else None
        matched_punch_ts_ms = (now_ms - matched_latency_ms) if matched_latency_ms is not None else None
        window_events = [
            item for item in self.recent_context_events
            if start_ms <= int(item.get("ts_ms", 0)) <= now_ms
        ]
        if len(window_events) > self.RESOLVE_CONTEXT_MAX_EVENTS:
            window_events = window_events[-self.RESOLVE_CONTEXT_MAX_EVENTS:]
        target_punches = [
            item for item in window_events
            if item.get("kind") == "UP_PUNCH" and str(item.get("target_id", "")) == target_id
        ]
        step_events = [item for item in window_events if item.get("kind") == "STEP_RX"]
        parsed_steps = []
        for item in step_events:
            fields = item.get("fields") or []
            if len(fields) < 6:
                continue
            parsed_steps.append(
                {
                    "ts_ms": int(item.get("ts_ms", 0)),
                    "raw_fields": fields,
                    "entity_id": str(fields[1]),
                    "x": fields[2],
                    "y": fields[3],
                    "orientation": fields[4],
                    "move_time": fields[5],
                    "extra": fields[6] if len(fields) > 6 else "",
                }
            )
        last_self_step = next((item for item in reversed(parsed_steps) if item["entity_id"] == my_scene_id), None)
        last_target_step = next((item for item in reversed(parsed_steps) if item["entity_id"] == opponent_id), None)
        relevant_step_candidates = [item for item in (last_self_step, last_target_step) if item is not None]
        last_relevant_step = max(relevant_step_candidates, key=lambda item: item["ts_ms"]) if relevant_step_candidates else None
        punches_after_relevant_step = [
            item for item in target_punches
            if last_relevant_step is not None and int(item.get("ts_ms", 0)) >= last_relevant_step["ts_ms"]
        ]
        match_after_relevant_step_ms = (
            matched_punch_ts_ms - last_relevant_step["ts_ms"]
            if last_relevant_step is not None and matched_punch_ts_ms is not None
            else None
        )
        resolve_after_relevant_step_ms = now_ms - last_relevant_step["ts_ms"] if last_relevant_step is not None else None
        self_step_vs_target_step_ms = None
        if last_self_step is not None and last_target_step is not None:
            self_step_vs_target_step_ms = last_self_step["ts_ms"] - last_target_step["ts_ms"]
        resolve_self_xy = None
        resolve_opp_xy = None
        if atk_id == my_scene_id:
            resolve_self_xy = self._safe_xy(evt.get("atk_x"), evt.get("atk_y"))
            resolve_opp_xy = self._safe_xy(evt.get("def_x"), evt.get("def_y"))
        elif def_id == my_scene_id:
            resolve_self_xy = self._safe_xy(evt.get("def_x"), evt.get("def_y"))
            resolve_opp_xy = self._safe_xy(evt.get("atk_x"), evt.get("atk_y"))
        cross_meta = self._classify_cross_taxonomy(
            my_scene_id,
            opponent_id,
            parsed_steps,
            last_self_step,
            last_target_step,
            resolve_self_xy=resolve_self_xy,
            resolve_opp_xy=resolve_opp_xy,
        )
        recent_state146 = self._recent_state146_events(window_events, now_ms)
        recent_state146_scene_ids = [
            str(item.get("mapped_scene_id") or "")
            for item in recent_state146
            if item.get("mapped_scene_id")
        ]
        target_entry = self.scene_roster.get(target_id, {})
        opponent_entry = self.scene_roster.get(opponent_id, {})
        context_event = {
            "type": "RESOLVE_CONTEXT",
            "role": role,
            "ts_ms": now_ms,
            "window_ms": self.RESOLVE_CONTEXT_WINDOW_MS,
            "my_scene_id": self.my_scene_id or "?",
            "my_account_id": self.my_player_id or "?",
            "target_id": target_id,
            "opponent_id": opponent_id,
            "target_name": target_entry.get("name", ""),
            "opponent_name": opponent_entry.get("name", ""),
            "atk_id": evt.get("atk_id", ""),
            "def_id": evt.get("def_id", ""),
            "matched_seq": match.get("seq"),
            "target_correct": match.get("target_correct"),
            "matched_latency_ms": matched_latency_ms,
            "matched_punch_ts_ms": matched_punch_ts_ms,
            "target_punch_count": len(target_punches),
            "last_self_step": last_self_step,
            "last_target_step": last_target_step,
            "last_relevant_step": last_relevant_step,
            "self_step_vs_target_step_ms": self_step_vs_target_step_ms,
            "match_after_last_relevant_step_ms": match_after_relevant_step_ms,
            "resolve_after_last_relevant_step_ms": resolve_after_relevant_step_ms,
            "match_before_last_relevant_step": bool(
                last_relevant_step is not None
                and matched_punch_ts_ms is not None
                and matched_punch_ts_ms < last_relevant_step["ts_ms"]
            ),
            "target_punches_after_last_relevant_step": len(punches_after_relevant_step),
            "cross_type": cross_meta.get("cross_type"),
            "cross_tags": cross_meta.get("cross_tags"),
            "cross_meta": cross_meta,
            "pre_resolve_state146_scene_ids": recent_state146_scene_ids,
            "pre_resolve_state146_covers_resolve_slots": bool(
                atk_id and def_id and atk_id in recent_state146_scene_ids and def_id in recent_state146_scene_ids
            ),
        }
        if self.config.detailed_events:
            context_event["pre_resolve_state146"] = recent_state146
            context_event["recent_events"] = window_events
        self.registry.add_event(context_event)
        self.resolve_context_samples.append(
            {
                "role": role,
                "target_correct": match.get("target_correct"),
                "cross_type": cross_meta.get("cross_type"),
                "matched_latency_ms": matched_latency_ms,
                "match_after_last_relevant_step_ms": match_after_relevant_step_ms,
                "resolve_after_last_relevant_step_ms": resolve_after_relevant_step_ms,
                "target_punches_after_last_relevant_step": len(punches_after_relevant_step),
                "target_punch_count": len(target_punches),
                "matched_source": match.get("source"),
            }
        )
        while len(self.resolve_context_samples) > 256:
            self.resolve_context_samples.pop(0)
        self.cross_taxonomy_samples.append(
            {
                "ts_ms": now_ms,
                "role": role,
                "cross_type": cross_meta.get("cross_type"),
                "cross_tags": cross_meta.get("cross_tags"),
                "target_correct": match.get("target_correct"),
                "target_id": target_id,
                "target_name": target_entry.get("name", ""),
                "opponent_id": opponent_id,
                "opponent_name": opponent_entry.get("name", ""),
                "self_scene_id": my_scene_id,
            }
        )
        while len(self.cross_taxonomy_samples) > 256:
            self.cross_taxonomy_samples.pop(0)

    def _match_resolve_to_punch(self, evt: dict, now_ms: int) -> Optional[dict]:
        with self.punch_samples_lock:
            self._expire_pending_punches(now_ms)
            if not self.pending_punches:
                self.resolve_mismatches += 1
                return None
            atk_id = evt.get("atk_id", "")
            def_id = evt.get("def_id", "")
            my_id = self.my_scene_id or ""
            best_idx: Optional[int] = None
            best_score: Optional[Tuple[int, int, int, int, int, int, int, int]] = None
            best_role = "unknown"
            best_latency = 0
            best_target_correct = False
            for idx, sample in enumerate(self.pending_punches):
                latency = now_ms - sample.ts_ms
                if latency < 0 or latency > self.PUNCH_LATE_WINDOW_MS:
                    continue
                target_match = int(sample.target_id in (atk_id, def_id))
                self_match = int(bool(my_id) and my_id in (atk_id, def_id))
                self_atk = int(bool(my_id) and atk_id == my_id)
                self_def = int(bool(my_id) and def_id == my_id)
                opponent_id = def_id if self_atk else atk_id if self_def else ""
                opponent_match = int(bool(opponent_id) and sample.target_id == opponent_id)
                self_target = int(bool(my_id) and sample.target_id == my_id)
                target_correct = int(
                    bool(my_id)
                    and (
                        (atk_id == my_id and def_id == sample.target_id)
                        or (def_id == my_id and atk_id == sample.target_id)
                    )
                )
                if my_id and not (self_atk and sample.target_id == def_id):
                    continue
                late_penalty = 1 if latency > self.PUNCH_MATCH_WINDOW_MS else 0
                score = (
                    target_correct,
                    opponent_match,
                    self_atk,
                    self_def,
                    self_match,
                    target_match,
                    -self_target,
                    -late_penalty,
                )
                if score <= (0, 0, 0, 0, 0, 0, -1, -1):
                    continue
                if best_score is None or score > best_score or (score == best_score and latency < best_latency):
                    best_idx = idx
                    best_score = score
                    best_latency = latency
                    if self_atk:
                        best_role = "self_atk"
                    elif self_def:
                        best_role = "self_def"
                    elif self_match:
                        best_role = "self_involved"
                    elif target_match:
                        best_role = "target_only"
                    else:
                        best_role = "unknown"
                    best_target_correct = bool(target_correct)
            if best_idx is None:
                self.resolve_mismatches += 1
                return None
            matched = self.pending_punches[best_idx]
            del self.pending_punches[best_idx]
            late = best_latency > self.PUNCH_MATCH_WINDOW_MS
            self.resolve_matches += 1
            if best_role == "self_atk":
                self.resolve_self_atk_matches += 1
                if not best_target_correct:
                    self.resolve_self_target_miss_matches += 1
            elif best_role == "self_def":
                self.resolve_self_def_matches += 1
                if not best_target_correct:
                    self.resolve_self_target_miss_matches += 1
            elif best_role == "target_only":
                self.resolve_target_only_matches += 1
            else:
                self.resolve_unknown_matches += 1
            if late:
                self.resolve_late_matches += 1
            self.match_latency_total_ms += best_latency
            self.match_latency_count += 1
            self.match_latency_recent.append(best_latency)
            while len(self.match_latency_recent) > self.MAX_MATCH_LOG:
                self.match_latency_recent.pop(0)
            # --- Contact V5: observe half_rtt from match latency ---
            self._observe_half_rtt(best_latency)
            match = {
                "seq": matched.seq,
                "target_id": matched.target_id,
                "source": matched.source,
                "copy_index": matched.copy_index,
                "copy_total": matched.copy_total,
                "move_attached": matched.move_attached,
                "latency_ms": best_latency,
                "role": best_role,
                "target_correct": best_target_correct,
                "late": late,
                "atk_id": atk_id,
                "def_id": def_id,
            }
            self.recent_punch_matches.append(match)
            while len(self.recent_punch_matches) > self.MAX_MATCH_LOG:
                self.recent_punch_matches.pop(0)
            return match

    def log(self, message: str, console: bool = True) -> None:
        line = f"[S{self.session_id}] {message}"
        self.registry.file_logger.write_session(self.session_id, line)
        if console:
            print(line, flush=True)

    @staticmethod
    def _bytes_preview(data: bytes, limit: int = 32) -> dict:
        head = bytes(data[:limit])
        return {
            "len": len(data),
            "head_hex": " ".join(f"{value:02X}" for value in head),
            "head_ascii": "".join(chr(value) if 32 <= value <= 126 else "." for value in head),
            "frame_start_count": data.count(FRAME_START),
            "frame_end_count": data.count(FRAME_END),
        }

    def _record_precrypto_chunk(self, data: bytes, downstream: bool) -> None:
        bucket = self.precrypto_down_chunks if downstream else self.precrypto_up_chunks
        if len(bucket) >= 8:
            return
        item = self._bytes_preview(data)
        item["dir"] = "down" if downstream else "up"
        bucket.append(item)
        self.log(
            f"precrypto {item['dir']} chunk len={item['len']} "
            f"starts={item['frame_start_count']} ends={item['frame_end_count']} "
            f"head={item['head_hex']}"
        )

    def _record_precrypto_frame(self, frame: bytes, downstream: bool) -> None:
        if downstream:
            self.precrypto_down_frame_count += 1
            bucket = self.precrypto_down_frames
            direction = "down"
        else:
            self.precrypto_up_frame_count += 1
            bucket = self.precrypto_up_frames
            direction = "up"
        if len(bucket) >= 8:
            return
        fields = parse_plaintext_frame(frame)
        item = self._bytes_preview(frame)
        item.update({
            "dir": direction,
            "opcode": format_opcode(extract_opcode(frame)),
            "fields": [field[:80] for field in fields[:4]],
        })
        bucket.append(item)
        self.log(
            f"precrypto {direction} frame opcode={item['opcode']} "
            f"len={item['len']} fields={item['fields']}"
        )

    def activate_crypto_pair(self, client_key: bytes, server_key: bytes, label: str = "RC4") -> None:
        self.client_decrypt = RC4(client_key)
        self.client_encrypt = RC4(client_key)
        self.server_encrypt = RC4(server_key)
        self.server_decrypt = RC4(server_key)
        self.down_plain_buffer = bytearray()
        self._pending_downstream = bytearray()
        self.downstream_lock = threading.Lock()
        self.crypto_active = True
        self.handshake.phase = HandshakeState.DONE
        self.log(f"{label} active multiply={self.config.multiply}x")
        self._start_proxy_contact_scanner()

    def activate_crypto(self) -> None:
        if not self.handshake.rc4_key_bytes:
            return
        self.activate_crypto_pair(self.handshake.rc4_key_bytes, self.handshake.rc4_key_bytes, "RC4")

    def apply_swf_rc4_key(self, key_bytes: bytes) -> bool:
        if self.crypto_active or not key_bytes:
            return False
        self.client_decrypt = RC4(key_bytes)
        self.server_encrypt = RC4(key_bytes)
        if self.swf_key_up_backlog:
            self.client_decrypt.crypt(bytes(self.swf_key_up_backlog))
            self.server_encrypt.crypt(bytes(self.swf_key_up_backlog))
        self.server_decrypt = RC4(key_bytes)
        self.client_encrypt = RC4(key_bytes)
        if self.swf_key_down_backlog:
            self.server_decrypt.crypt(bytes(self.swf_key_down_backlog))
            self.client_encrypt.crypt(bytes(self.swf_key_down_backlog))
        self.swf_key_up_backlog = bytearray()
        self.swf_key_down_backlog = bytearray()
        self.up_plain_buffer = bytearray()
        self.down_plain_buffer = bytearray()
        self.swf_key_applied = True
        self.swf_key_pending = False
        self.crypto_active = True
        self.handshake.phase = HandshakeState.DONE
        self.log(f"SWF RC4 active multiply={self.config.multiply}x")
        self._start_proxy_contact_scanner()
        return True

    def _ecdh_ensure_proxy_key(self) -> bool:
        if not HAS_X25519:
            self.last_error = "cryptography.x25519 no disponible"
            self.log("ECDH unavailable: install cryptography")
            return False
        if self.ecdh_private is None:
            self.ecdh_private = x25519.X25519PrivateKey.generate()
            public = self.ecdh_private.public_key().public_bytes(
                encoding=serialization.Encoding.Raw,
                format=serialization.PublicFormat.Raw,
            )
            self.ecdh_public_hex = public.hex()
            self.log(f"ECDH proxy pub {self.ecdh_public_hex}")
        return True

    def _ecdh_shared_rc4_key(self, public_hex: str) -> bytes:
        if not self._ecdh_ensure_proxy_key():
            return b""
        public_bytes = bytes.fromhex(public_hex)
        public_key = x25519.X25519PublicKey.from_public_bytes(public_bytes)
        shared = self.ecdh_private.exchange(public_key)
        return hashlib.sha256(shared).digest()

    def _maybe_activate_ecdh_crypto(self) -> None:
        if self.crypto_active:
            return
        if self.ecdh_client_key_bytes is not None and self.ecdh_server_key_bytes is not None:
            self.activate_crypto_pair(self.ecdh_client_key_bytes, self.ecdh_server_key_bytes, "ECDH RC4")

    def _transform_ecdh_handshake_frame(self, frame: bytes, downstream: bool) -> Tuple[bytes, bool]:
        opcode = extract_opcode(frame)
        fields = parse_plaintext_frame(frame)
        if not downstream and opcode == (233, 41):
            self.handshake.phase = HandshakeState.WAITING_DH_PARAMS
            self.log("ECDH cert challenge passthrough")
            return frame, True
        if downstream and opcode == (232,):
            self.log("ECDH cert signature passthrough")
            return frame, True
        if not downstream and opcode == (233, 42) and len(fields) >= 2:
            if not self._ecdh_ensure_proxy_key():
                return frame, True
            try:
                self.ecdh_client_public_hex = fields[1]
                self.ecdh_client_key_bytes = self._ecdh_shared_rc4_key(fields[1])
                self.handshake.phase = HandshakeState.WAITING_SERVER_PUB
                self.log("ECDH client pub replaced for upstream")
                return build_plaintext_frame((233, 42), [self.ecdh_public_hex or ""]), True
            except Exception as error:
                self.last_error = f"ECDH client pub error: {error}"
                self.log(self.last_error)
                return frame, True
        if downstream and opcode == (234,) and len(fields) >= 2:
            if not self._ecdh_ensure_proxy_key():
                return frame, True
            try:
                self.ecdh_server_public_hex = fields[1]
                self.ecdh_server_key_bytes = self._ecdh_shared_rc4_key(fields[1])
                transformed = build_plaintext_frame((234,), [self.ecdh_public_hex or ""])
                self.log("ECDH server pub replaced for downstream")
                self._maybe_activate_ecdh_crypto()
                return transformed, True
            except Exception as error:
                self.last_error = f"ECDH server pub error: {error}"
                self.log(self.last_error)
                return frame, True
        return frame, False

    def log_handshake_frame(self, frame: bytes, downstream: bool) -> None:
        if not self.config.verbose or self.crypto_active:
            return
        budget_name = "handshake_debug_server" if downstream else "handshake_debug_client"
        remaining = getattr(self, budget_name)
        if remaining <= 0:
            return
        setattr(self, budget_name, remaining - 1)
        fields = parse_plaintext_frame(frame)
        head = " ".join(f"{value:02X}" for value in frame[:20])
        field0 = fields[0] if fields else ""
        ords = ",".join(str(ord(ch)) for ch in field0[:4]) if field0 else ""
        preview_fields = []
        for field in fields[:3]:
            text = field
            if len(text) > 48:
                text = text[:48] + "..."
            preview_fields.append(text.encode("unicode_escape").decode("ascii"))
        direction = "down" if downstream else "up"
        self.log(
            f"handshake {direction} frame len={len(frame)} "
            f"head={head} field0_ords=[{ords}] fields={preview_fields}"
        )

    def log_upstream_frame(self, frame: bytes, is_punch: bool, target: Optional[str]) -> None:
        if not self.config.verbose:
            return
        opcode = extract_opcode(frame)
        fields = parse_plaintext_frame(frame)
        preview_fields = []
        for field in fields[:4]:
            text = field
            if len(text) > 60:
                text = text[:60] + "..."
            preview_fields.append(text.encode("unicode_escape").decode("ascii"))
        suffix = f" target={target}" if is_punch and target is not None else ""
        self.log(
            f"UP opcode={format_opcode(opcode)} len={len(frame)}"
            f"{suffix} fields={preview_fields}"
        )

    def log_downstream_frame(self, frame: bytes) -> None:
        if not self.config.verbose:
            return
        opcode = extract_opcode(frame)
        fields = parse_plaintext_frame(frame)
        # Show ALL fields for combat-related opcodes (211=punch, 184/120=HP, 144=ack)
        is_combat = opcode in ((211,), (184, 120), (144,), (143,))
        max_fields = 12 if is_combat else 4
        preview_fields = []
        for field in fields[:max_fields]:
            text = field
            if len(text) > 60:
                text = text[:60] + "..."
            preview_fields.append(text.encode("unicode_escape").decode("ascii"))
        self.log(
            f"DOWN opcode={format_opcode(opcode)} len={len(frame)}"
            f" fields={preview_fields}"
        )

    def maybe_log_stats(self) -> None:
        if not self.config.verbose:
            return
        now = time.time()
        if now - self.last_stats_at < 1.0:
            return
        up_delta = self.up_bytes - self.last_up_bytes
        down_delta = self.down_bytes - self.last_down_bytes
        self.last_up_bytes = self.up_bytes
        self.last_down_bytes = self.down_bytes
        self.last_stats_at = now
        total_sent = self.punches_seen + self.punches_injected
        eff = float(total_sent) / float(self.punches_seen) if self.punches_seen > 0 else 0.0
        self.log(
            "stats "
            f"phase={self.handshake.phase} "
            f"crypto={'on' if self.crypto_active else 'off'} "
            f"up={self.up_bytes}B (+{up_delta}) "
            f"down={self.down_bytes}B (+{down_delta}) "
            f"seen={self.punches_seen} inj={self.punches_injected} "
            f"sent={total_sent} eff={eff:.2f}x"
        )

    def connect_remote(self) -> None:
        tune_socket(self.client_sock)
        tune_socket(self.remote_sock, server_side=True)
        self.registry.wait_for_swf_remote_report()
        self.remote_sock.connect((self.config.remote_host, self.config.remote_port))
        self.log(f"connected remote {self.config.remote_host}:{self.config.remote_port} mode={self.config.mode}")

    def close(self) -> None:
        self._stop_proxy_contact_scanner()
        for sock in (self.client_sock, self.remote_sock):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass

    def forward_plain_and_sniff(self, data: bytes, downstream: bool) -> None:
        self._record_precrypto_chunk(data, downstream)
        target = self.client_sock if downstream else self.remote_sock
        buffer = self.down_plain_buffer if downstream else self.up_plain_buffer
        if self.precrypto_passthrough:
            target.sendall(data)
            return
        if self.handshake.phase == HandshakeState.WAITING_INIT and not buffer and data and data[0] != FRAME_START:
            # Some login/auth sockets are already opaque before the BB ECDH
            # frames. Treating random bytes as B1/B0 frames can retain a tail
            # forever and freeze login, so fail open for this session only.
            self.precrypto_passthrough = True
            self.log(
                "precrypto opaque; switching this session to transparent passthrough",
                console=True,
            )
            target.sendall(data)
            return
        buffer = self.down_plain_buffer if downstream else self.up_plain_buffer
        buffer.extend(data)
        prefix, frames, remainder = split_complete_frames(buffer)
        if downstream:
            self.down_plain_buffer = remainder
        else:
            self.up_plain_buffer = remainder
        out = bytearray(prefix)
        for frame in frames:
            self._record_precrypto_frame(frame, downstream)
            transformed, handled_ecdh = self._transform_ecdh_handshake_frame(frame, downstream)
            out.extend(transformed)
            if not handled_ecdh:
                self.log_handshake_frame(frame, downstream)
                if downstream:
                    prev_phase = self.handshake.phase
                    self.handshake.process_server_frame(frame)
                    if self.config.verbose and self.handshake.phase != prev_phase:
                        self.log(f"handshake server phase {prev_phase}->{self.handshake.phase}")
                    if self.handshake.phase == HandshakeState.DONE and not self.crypto_active:
                        self.activate_crypto()
                else:
                    prev_phase = self.handshake.phase
                    self.handshake.process_client_frame(frame)
                    if self.config.verbose and self.handshake.phase != prev_phase:
                        self.log(f"handshake client phase {prev_phase}->{self.handshake.phase}")
        if out:
            target.sendall(bytes(out))

    def observe_plain_handshake_swf_key(self, data: bytes, downstream: bool) -> None:
        buffer = self.down_plain_buffer if downstream else self.up_plain_buffer
        buffer.extend(data)
        _prefix, frames, remainder = split_complete_frames(buffer)
        if downstream:
            self.down_plain_buffer = remainder
        else:
            self.up_plain_buffer = remainder
        for frame in frames:
            self._record_precrypto_frame(frame, downstream)
            opcode = extract_opcode(frame)
            self.log_handshake_frame(frame, downstream)
            if not downstream and opcode == (233, 41):
                self.handshake.phase = HandshakeState.WAITING_DH_PARAMS
                self.log("SWFKEY ECDH cert challenge passthrough")
            elif downstream and opcode == (232,):
                self.log("SWFKEY ECDH cert signature passthrough")
            elif not downstream and opcode == (233, 42):
                self.handshake.phase = HandshakeState.WAITING_SERVER_PUB
                self.log("SWFKEY client pub passthrough")
            elif downstream and opcode == (234,):
                self.swf_key_pending = True
                self.handshake.phase = HandshakeState.WAITING_SERVER_PUB
                self.log("SWFKEY server pub passthrough; waiting for SWF RC4 key")

    def forward_plain_swf_key(self, data: bytes, downstream: bool) -> None:
        target = self.client_sock if downstream else self.remote_sock
        target.sendall(data)
        self._record_precrypto_chunk(data, downstream)
        if self.swf_key_pending:
            if downstream:
                self.swf_key_down_backlog.extend(data)
            else:
                self.swf_key_up_backlog.extend(data)
            return
        self.observe_plain_handshake_swf_key(data, downstream)

    @staticmethod
    def is_scene_player_id(value: str) -> bool:
        if not value or not value.isdigit():
            return False
        try:
            numeric = int(value)
        except ValueError:
            return False
        return 0 <= numeric <= 255 and len(value) <= 3

    @staticmethod
    def is_probable_ring_scene_id(value: str) -> bool:
        if not value or not value.isdigit():
            return False
        try:
            numeric = int(value)
        except ValueError:
            return False
        return 0 <= numeric <= MAX_RING_SCENE_ID

    @staticmethod
    def is_account_player_id(value: str) -> bool:
        return bool(value) and value.isdigit() and len(value) >= 6

    def register_player_mapping(self, scene_id: str, account_id: str, player_name: str = "") -> None:
        scene_id = str(scene_id)
        account_id = str(account_id)
        if not self.is_scene_player_id(scene_id) or not self.is_probable_ring_scene_id(scene_id) or not self.is_account_player_id(account_id):
            return
        previous_scene = self.account_to_scene_id.get(account_id)
        previous_account = self.scene_to_account_id.get(scene_id)
        if previous_scene and previous_scene != scene_id:
            old_entry = self.scene_roster.get(previous_scene)
            if old_entry and old_entry.get("account_id") == account_id:
                old_entry["account_id"] = None
        if previous_account and previous_account != account_id:
            old_entry = self.scene_roster.get(scene_id)
            if old_entry and old_entry.get("account_id") == previous_account:
                old_entry["account_id"] = None
            if self.account_to_scene_id.get(previous_account) == scene_id:
                del self.account_to_scene_id[previous_account]
        self.account_to_scene_id[account_id] = scene_id
        self.scene_to_account_id[scene_id] = account_id
        self.ring_player_ids.add(scene_id)
        entry = self._roster_entry(scene_id)
        entry["scene_id"] = scene_id
        entry["account_id"] = account_id
        if player_name:
            entry["name"] = player_name
        entry["last_seen_ts_ms"] = int(time.time() * 1000)
        self._apply_cached_account_state(entry, account_id)
        self._apply_memory_labels(entry, account_id)
        self.registry.roster_memory.update_player(account_id, name=player_name or None, scene_id=scene_id)
        if self.my_player_id == account_id:
            self.has_seen_ring_resolve = False  # Reset on scene mapping
            if self.my_scene_id != scene_id or self.my_scene_source != "account":
                self.my_scene_id = scene_id
                self.my_scene_source = "account"
                self.log(f"MY scene ID: {scene_id} (account={account_id})", console=self.config.verbose)
        if previous_scene != scene_id or previous_account != account_id:
            self.registry.add_event(
                {
                    "type": "PLAYER_MAP",
                    "scene_id": scene_id,
                    "account_id": account_id,
                    "name": player_name or "",
                    "my_account_id": self.my_player_id or "?",
                    "my_scene_id": self.my_scene_id or "?",
                }
            )

    def _update_roster_from_board_entity(self, entity: dict, now_ms: int) -> None:
        self._update_roster_from_live_entity(entity, now_ms, "board")

    def _update_roster_from_live_entity(self, entity: dict, now_ms: int, source: str = "board") -> None:
        scene_id_raw = entity.get("sceneId", entity.get("id"))
        scene_id = str(scene_id_raw) if scene_id_raw is not None else ""
        if not self.is_scene_player_id(scene_id) or not self.is_probable_ring_scene_id(scene_id):
            return
        entry = self._roster_entry(scene_id)
        old_state = self._proxy_release_state_int(entry.get("state_code"))
        old_combat_busy = bool(entry.get("combat_busy"))
        old_busy_seen_at = entry.get("last_combat_busy_ts_ms")
        name = str(entity.get("name") or "").strip()
        if name:
            entry["name"] = name
        account_raw = entity.get("accountId", entity.get("account_id", entity.get("userId")))
        account_id = str(account_raw) if account_raw not in (None, "") else ""
        if self.is_account_player_id(account_id):
            previous_account = entry.get("account_id")
            entry["account_id"] = account_id
            self.account_to_scene_id[account_id] = scene_id
            self.scene_to_account_id[scene_id] = account_id
            if previous_account and previous_account != account_id and self.account_to_scene_id.get(str(previous_account)) == scene_id:
                del self.account_to_scene_id[str(previous_account)]
            if name:
                self.registry.roster_memory.update_player(account_id, name=name, scene_id=scene_id)
        skin_id = entity.get("skinId")
        if skin_id not in (None, "", -1, "-1"):
            entry["skin_id"] = str(skin_id)
        member = entity.get("member")
        if member not in (None, ""):
            entry["member"] = str(member)
        pet_id = entity.get("petId")
        if pet_id not in (None, "", -1, "-1"):
            entry["pet_id"] = str(pet_id)
        x_value = entity.get("x")
        y_value = entity.get("y")
        orientation = entity.get("orientation")
        try:
            board_x = int(round(float(x_value))) if x_value is not None else None
            board_y = int(round(float(y_value))) if y_value is not None else None
        except (TypeError, ValueError):
            board_x = None
            board_y = None
        from_x_value = entity.get("fromX", entity.get("from_x"))
        from_y_value = entity.get("fromY", entity.get("from_y"))
        to_x_value = entity.get("toX", entity.get("to_x", x_value))
        to_y_value = entity.get("toY", entity.get("to_y", y_value))
        try:
            from_x = int(round(float(from_x_value))) if from_x_value is not None else None
            from_y = int(round(float(from_y_value))) if from_y_value is not None else None
            to_x = int(round(float(to_x_value))) if to_x_value is not None else board_x
            to_y = int(round(float(to_y_value))) if to_y_value is not None else board_y
        except (TypeError, ValueError):
            from_x = None
            from_y = None
            to_x = board_x
            to_y = board_y
        has_pose = (board_x is not None and board_y is not None) or (to_x is not None and to_y is not None)
        if has_pose:
            if from_x is not None:
                entry["prev_x"] = from_x
            if from_y is not None:
                entry["prev_y"] = from_y
            if to_x is not None:
                entry["x"] = str(to_x)
            elif board_x is not None:
                entry["x"] = str(board_x)
            if to_y is not None:
                entry["y"] = str(to_y)
            elif board_y is not None:
                entry["y"] = str(board_y)
            last_move_ts = entry.get("last_move_ts_ms")
            move_age_ms = now_ms - int(last_move_ts) if isinstance(last_move_ts, int) else 999999
            step_dur = parse_int_field(entity.get("stepDur", entity.get("step_ms")), 0) or 0
            self._observe_step_ms(step_dur, source)
            moving = parse_bool(entity.get("moving")) or (from_x is not None and from_y is not None and to_x is not None and to_y is not None and (from_x != to_x or from_y != to_y))
            if moving and step_dur > 0:
                try:
                    phase = float(entity.get("phase") or 0.0)
                except (TypeError, ValueError):
                    phase = 0.0
                phase = max(0.0, min(1.0, phase))
                entry["last_move_ts_ms"] = now_ms - int(round(float(step_dur) * phase))
                entry["step_ms"] = int(max(0, min(1600, step_dur)))
            elif not moving:
                entry["prev_x"] = to_x if to_x is not None else board_x
                entry["prev_y"] = to_y if to_y is not None else board_y
                entry["step_ms"] = 0
                entry["last_move_ts_ms"] = now_ms
            elif move_age_ms > 1600:
                entry["prev_x"] = to_x if to_x is not None else board_x
                entry["prev_y"] = to_y if to_y is not None else board_y
                entry["step_ms"] = 0
            entry["last_pose_ts_ms"] = now_ms
            if source == "board":
                entry["last_board_pose_ts_ms"] = now_ms
            else:
                entry["last_hub_pose_ts_ms"] = now_ms
        if orientation not in (None, ""):
            entry["orientation"] = str(int(orientation))
        combat_state = entity.get("combatState") or {}
        if not isinstance(combat_state, dict):
            combat_state = {}
        state_value = combat_state.get("state")
        if state_value not in (None, ""):
            entry["state_code"] = str(state_value)
        new_state = self._proxy_release_state_int(entry.get("state_code"))
        combat_busy = self._proxy_release_combat_busy(combat_state)
        combat_ready = self._proxy_release_combat_ready(combat_state)
        ready_delay_ms = self._proxy_release_ready_delay_from_combat(combat_state)
        entry["combat_busy"] = combat_busy
        entry["combat_ready"] = combat_ready
        entry["combat_attack"] = parse_bool(combat_state.get("attack"))
        entry["combat_react"] = parse_bool(combat_state.get("react"))
        entry["combat_progress"] = combat_state.get("progress")
        entry["combat_frame"] = combat_state.get("frame")
        entry["combat_total"] = combat_state.get("total")
        entry["combat_anim"] = combat_state.get("anim")
        entry["last_combat_ts_ms"] = now_ms
        if combat_busy:
            entry["last_combat_busy_ts_ms"] = now_ms
        entry["board_is_self"] = entity.get("isSelf") is True or parse_bool(entity.get("isSelf"))
        if entry["board_is_self"] and (self.my_scene_id != scene_id or self.my_scene_source != "hub_swf"):
            self.my_scene_id = scene_id
            self.my_scene_source = "hub_swf" if source != "board" else "board"
            self.pending_self_scene_candidate = None
        if source == "board":
            entry["last_board_ts_ms"] = now_ms
        else:
            entry["last_hub_ts_ms"] = now_ms
        entry["last_seen_ts_ms"] = now_ms
        if entry["board_is_self"] or str(scene_id) == str(self.my_scene_id):
            recent_busy = isinstance(old_busy_seen_at, int) and now_ms - int(old_busy_seen_at) <= PROXY_RELEASE_RECENT_BUSY_MS
            release_ready = combat_ready or (old_combat_busy and not combat_busy) or (recent_busy and not combat_busy)
            current_debug = self.proxy_release_counter_last_debug if isinstance(self.proxy_release_counter_last_debug, dict) else {}
            if (
                (not current_debug or current_debug.get("watch"))
                and now_ms - self.proxy_release_counter_last_fire_at_ms > 120
                and now_ms - self.proxy_release_counter_last_arm_at_ms > 120
            ):
                self.proxy_release_counter_last_debug = {
                    "watch": source,
                    "scene_id": scene_id,
                    "state": new_state if new_state is not None else entry.get("state_code"),
                    "busy": combat_busy,
                    "ready": release_ready,
                    "ready_delay_ms": ready_delay_ms if ready_delay_ms < 999999 else None,
                    "combat": combat_state,
                    "self_source": self.my_scene_source or "none",
                }
            if old_combat_busy or combat_busy or old_state != new_state:
                self._proxy_release_counter_start(
                    old_state,
                    new_state,
                    now_ms,
                    source=source,
                    old_busy=old_combat_busy,
                    new_busy=combat_busy,
                    new_ready=release_ready,
                )
            if combat_busy and ready_delay_ms <= PROXY_RELEASE_PREARM_MAX_MS:
                self._proxy_release_counter_prearm(
                    now_ms,
                    ready_delay_ms,
                    source=f"{source}_prearm",
                    state_label=str(new_state if new_state is not None else entry.get("state_code") or "?"),
                    combat_state=combat_state,
                )

    def apply_hub_entities(self, entities: List[object], now_ms: int) -> int:
        applied = 0
        for entity in entities:
            if not isinstance(entity, dict) or not parse_bool(entity.get("isSelf")):
                continue
            scene_id_raw = entity.get("sceneId", entity.get("id"))
            scene_id = str(scene_id_raw) if scene_id_raw not in (None, "") else ""
            if self.is_scene_player_id(scene_id) and self.is_probable_ring_scene_id(scene_id):
                self.my_scene_id = scene_id
                self.my_scene_source = "hub_swf"
                self.pending_self_scene_candidate = None
                break
        for entity in entities:
            if not isinstance(entity, dict):
                continue
            self._update_roster_from_live_entity(entity, now_ms, "hub_live")
            applied += 1
        return applied

    def maybe_refresh_from_board(self, now_ms: Optional[int] = None) -> None:
        stamp = int(time.time() * 1000) if now_ms is None else int(now_ms)
        if stamp - self.last_board_sync_ms < BOARD_STATE_REFRESH_MS:
            return
        self.last_board_sync_ms = stamp
        try:
            with urllib.request.urlopen(BOARD_STATE_URL, timeout=BOARD_STATE_TIMEOUT_SEC) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, ValueError, OSError):
            return
        entities = payload.get("entities") or payload.get("payload", {}).get("entities") or []
        if not isinstance(entities, list):
            return
        self_entity = None
        for entity in entities:
            if not isinstance(entity, dict):
                continue
            if parse_bool(entity.get("isSelf")):
                self_entity = entity
                board_scene_id_raw = self_entity.get("sceneId", self_entity.get("id"))
                board_scene_id = str(board_scene_id_raw) if board_scene_id_raw not in (None, "") else ""
                if self.is_scene_player_id(board_scene_id) and self.is_probable_ring_scene_id(board_scene_id):
                    self.my_scene_id = board_scene_id
                    self.my_scene_source = "board"
                    self.pending_self_scene_candidate = None
                break
        for entity in entities:
            if not isinstance(entity, dict):
                continue
            self._update_roster_from_board_entity(entity, stamp)
        if self_entity is None:
            return
        if not isinstance(self_entity, dict):
            return
        board_scene_id_raw = self_entity.get("sceneId", self_entity.get("id"))
        if board_scene_id_raw in (None, ""):
            return
        board_scene_id = str(board_scene_id_raw)
        if not self.is_scene_player_id(board_scene_id) or not self.is_probable_ring_scene_id(board_scene_id):
            return
        if self.my_scene_id != board_scene_id or self.my_scene_source not in ("account", "opcode134", "board", "hub_swf"):
            self.my_scene_id = board_scene_id
            self.my_scene_source = "board"
            self.registry.add_event(
                {
                    "type": "MY_SCENE_ID_BOARD",
                    "scene_id": board_scene_id,
                    "account_id": self.my_player_id or "?",
                }
            )

    def maybe_update_my_scene_id(self) -> None:
        if self.my_player_id and not self.my_scene_id:
            mapped = self.account_to_scene_id.get(self.my_player_id)
            if mapped:
                self.my_scene_id = mapped
                self.my_scene_source = "account"
                self.log(f"MY scene ID: {mapped} (account={self.my_player_id})", console=self.config.verbose)
                return
            if self.pending_self_scene_candidate is not None:
                scene_id, player_name, candidate_ts_ms = self.pending_self_scene_candidate
                now_ms = int(time.time() * 1000)
                if now_ms - candidate_ts_ms <= 15000 and self.is_probable_ring_scene_id(scene_id):
                    self.my_scene_id = scene_id
                    self.my_scene_source = "heuristic"
                    self.ring_player_ids.add(scene_id)
                    self.log(
                        f"MY scene ID (heuristic): {scene_id} (account={self.my_player_id}, name={player_name})",
                        console=self.config.verbose,
                    )
                    self.registry.add_event(
                        {
                            "type": "MY_SCENE_ID_HEURISTIC",
                            "scene_id": scene_id,
                            "player_name": player_name or "",
                            "account_id": self.my_player_id,
                        }
                    )
                    self.pending_self_scene_candidate = None

    def extract_player_mapping_from_fields(self, fields: List[str]) -> Tuple[Optional[str], Optional[str], str]:
        if len(fields) < 3:
            return None, None, ""
        scene_id = fields[1] if self.is_scene_player_id(fields[1]) else None
        player_name = fields[2] if len(fields) >= 3 else ""
        candidate_account_id: Optional[str] = None
        preferred_indices = [27, 28, 29, 30, 31, 32, 33, 26, 25, 24, 23, 22, 21, 20]
        for idx in preferred_indices:
            if idx < len(fields):
                value = fields[idx]
                if self.is_account_player_id(value):
                    candidate_account_id = value
                    break
        return scene_id, candidate_account_id, player_name

    @staticmethod
    def _normalize_frame_fields(fields: List[str]) -> List[str]:
        if not fields:
            return []
        first = fields[0]
        if first and not first.isdigit():
            return fields[1:]
        return fields

    def _roster_entry(self, scene_id: str) -> Dict[str, object]:
        scene_id = str(scene_id)
        entry = self.scene_roster.get(scene_id)
        if entry is None:
            entry = {
                "scene_id": scene_id,
                "account_id": None,
                "name": "",
                "skin_id": None,
                "x": None,
                "y": None,
                "orientation": None,
                "state_code": None,
                "state_arg1": None,
                "state_arg2": None,
                "member": None,
                "pet_id": None,
                "last_move_ts_ms": None,
                "last_move_hms": "",
                "last_move_ago_ms": None,
                "moving_recent": False,
                "last_seen_ts_ms": None,
                "seen_in_scene_frame": False,
                "seen_in_step": False,
                "seen_in_state": False,
            }
            self.scene_roster[scene_id] = entry
        return entry

    def _apply_cached_account_state(self, entry: Dict[str, object], account_id: Optional[str]) -> None:
        if not account_id:
            return
        cached = self.account_state_cache.get(str(account_id))
        if not cached:
            return
        entry["state_code"] = cached.get("state_code")
        entry["state_arg1"] = cached.get("state_arg1")
        entry["state_arg2"] = cached.get("state_arg2")
        entry["last_seen_ts_ms"] = cached.get("ts_ms")
        entry["seen_in_state"] = True

    def _apply_memory_labels(self, entry: Dict[str, object], account_id: Optional[str]) -> None:
        if not account_id:
            return
        cached = self.registry.roster_memory.get(str(account_id))
        if not cached:
            return
        if not entry.get("name") and cached.get("name"):
            entry["name"] = cached.get("name")
        if entry.get("skin_id") in (None, "") and cached.get("skin_id") not in (None, ""):
            entry["skin_id"] = cached.get("skin_id")
        if entry.get("member") in (None, "") and cached.get("member") not in (None, ""):
            entry["member"] = cached.get("member")

    def _update_roster_from_scene_person_frame(self, fields: List[str], now_ms: int) -> None:
        data = self._normalize_frame_fields(fields)
        if len(data) < 28:
            return
        blocks: List[List[str]] = []
        if len(data) % 28 == 0:
            for idx in range(0, len(data), 28):
                blocks.append(data[idx : idx + 28])
        else:
            blocks.append(data[:28])
        for block in blocks:
            if len(block) < 28:
                continue
            scene_id = str(block[0])
            if not self.is_scene_player_id(scene_id) or not self.is_probable_ring_scene_id(scene_id):
                continue
            name = block[1]
            skin_id = block[2]
            x = block[4]
            y = block[5]
            orientation = block[6]
            member = block[24] if len(block) > 24 else None
            account_id = block[26] if len(block) > 26 else None
            pet_id = block[27] if len(block) > 27 else None
            if not self.is_account_player_id(str(account_id or "")):
                account_id = self.scene_to_account_id.get(scene_id)
            entry = self._roster_entry(scene_id)
            entry["name"] = name
            entry["skin_id"] = skin_id
            entry["x"] = x
            entry["y"] = y
            entry["orientation"] = orientation
            entry["last_scene_pose_ts_ms"] = now_ms
            entry["member"] = member
            entry["pet_id"] = pet_id
            entry["last_seen_ts_ms"] = now_ms
            entry["seen_in_scene_frame"] = True
            if self.is_account_player_id(str(account_id or "")):
                entry["account_id"] = str(account_id)
                if str(account_id) == self.my_player_id:
                    self.has_seen_ring_resolve = False  # Reset on scene mapping
                self.registry.roster_memory.update_player(
                    str(account_id),
                    name=name,
                    skin_id=skin_id,
                    scene_id=scene_id,
                    member=member,
                )
                self.register_player_mapping(scene_id, str(account_id), name)
                self._apply_memory_labels(entry, str(account_id))

    def _update_roster_from_short_name_frame(self, fields: List[str], now_ms: int) -> None:
        """
        Handle compact scene identity frames seen in ring logs, typically:
        [scene_id, name, skin_id, ...]
        """
        data = self._normalize_frame_fields(fields)
        if len(data) < 3:
            return
        scene_id = str(data[0])
        if not self.is_scene_player_id(scene_id) or not self.is_probable_ring_scene_id(scene_id):
            return

        name = str(data[1] or "").strip()
        skin_raw = data[2] if len(data) > 2 else None
        skin_id = str(skin_raw) if skin_raw not in (None, "") else None
        if not name and skin_id in (None, ""):
            return

        entry = self._roster_entry(scene_id)
        if name:
            entry["name"] = name
        if skin_id not in (None, ""):
            entry["skin_id"] = skin_id
        entry["last_seen_ts_ms"] = now_ms
        entry["seen_in_scene_frame"] = True

        account_id = entry.get("account_id")
        if self.is_account_player_id(str(account_id or "")):
            self.registry.roster_memory.update_player(
                str(account_id),
                name=name or None,
                skin_id=skin_id,
                scene_id=scene_id,
            )
            self._apply_memory_labels(entry, str(account_id))

    def _update_roster_from_step(self, fields: List[str], now_ms: int) -> None:
        records = self._parse_step_records(fields, now_ms)
        self._update_roster_from_step_records(records, now_ms)

    def _parse_step_records(self, fields: List[str], now_ms: int) -> List[Dict[str, object]]:
        data = self._normalize_frame_fields(fields)
        if len(data) < 6:
            return []
        stride = 7 if len(data) >= 7 else 6
        if len(data) % 7 == 0:
            stride = 7
        elif len(data) % 6 == 0:
            stride = 6
        records: List[Dict[str, object]] = []
        idx = 0
        while idx + 5 < len(data):
            block = data[idx : idx + stride]
            if len(block) < 6:
                break
            scene_id = str(block[1])
            x_value = parse_int_field(block[2])
            y_value = parse_int_field(block[3])
            orientation = parse_int_field(block[4], 0) or 0
            step_ms = parse_int_field(block[5], 0) or 0
            if self.is_scene_player_id(scene_id) and self.is_probable_ring_scene_id(scene_id) and x_value is not None and y_value is not None:
                entry = self._roster_entry(scene_id)
                old_x = parse_int_field(entry.get("x"))
                old_y = parse_int_field(entry.get("y"))
                if old_x is None or old_y is None:
                    dx, dy = MOVE_DIR.get(orientation, (0, 0))
                    old_x = int(x_value) - dx
                    old_y = int(y_value) - dy
                records.append(
                    {
                        "scene_id": scene_id,
                        "x": int(x_value),
                        "y": int(y_value),
                        "from_x": int(old_x),
                        "from_y": int(old_y),
                        "orientation": int(orientation),
                        "step_ms": int(step_ms),
                        "fields": block,
                        "ts_ms": now_ms,
                    }
                )
            idx += stride
        return records

    def _update_roster_from_step_records(self, records: List[Dict[str, object]], now_ms: int) -> None:
        if not records:
            return
        for record in records:
            scene_id = str(record.get("scene_id") or "")
            if not self.is_scene_player_id(scene_id) or not self.is_probable_ring_scene_id(scene_id):
                continue
            entry = self._roster_entry(scene_id)
            entry["prev_x"] = record.get("from_x")
            entry["prev_y"] = record.get("from_y")
            entry["x"] = str(record.get("x"))
            entry["y"] = str(record.get("y"))
            entry["orientation"] = str(record.get("orientation"))
            entry["step_ms"] = int(record.get("step_ms") or 0)
            self._observe_step_ms(entry["step_ms"], "opcode182")
            entry["last_move_ts_ms"] = now_ms
            entry["last_pose_ts_ms"] = now_ms
            entry["last_move_hms"] = time.strftime("%H:%M:%S", time.localtime(now_ms / 1000.0))
            entry["last_move_ago_ms"] = 0
            entry["moving_recent"] = True
            entry["last_seen_ts_ms"] = now_ms
            entry["seen_in_step"] = True
            self.ring_player_ids.add(scene_id)
            self._apply_memory_labels(entry, entry.get("account_id"))
            # --- Contact V5 Fix 5: track direction history per target ---
            ori = int(record.get("orientation") or 0)
            if ori > 0:
                hist = self.target_direction_history.get(scene_id)
                if hist is None:
                    hist = []
                    self.target_direction_history[scene_id] = hist
                hist.append(ori)
                if len(hist) > 4:
                    hist.pop(0)
            # Keep post-resolve/post-send inhibit even if our own movement arrives.
            # Otherwise movement during punch animation can re-arm auto punch early.
            if scene_id == str(self.my_scene_id or ""):
                if now_ms < self.proxy_contact_inhibit_until_ms:
                    remaining = self.proxy_contact_inhibit_until_ms - now_ms
                    self.proxy_contact_counter_last_debug = {
                        "skip": "self_move_during_inhibit",
                        "inhibit_ms": remaining,
                    }
                if now_ms < self.packet_brain_inhibit_until_ms:
                    self.packet_brain_last_debug = {
                        "skip": "self_move_during_inhibit",
                        "inhibit_ms": self.packet_brain_inhibit_until_ms - now_ms,
                    }

    @staticmethod
    def _punch_lateral_xy(self_x: int, self_y: int, target_x: int, target_y: int) -> bool:
        dx = target_x - self_x
        dy = target_y - self_y
        return dx != 0 and dy != 0 and dx * dy > 0 and abs(dx) == 1 and abs(dy) == 1

    def _proxy_auto_punch_block(self, now_ms: int, include_recent_busy: bool = True) -> Optional[Dict[str, object]]:
        if not self.my_scene_id:
            return None
        self_entry = self.scene_roster.get(str(self.my_scene_id))
        if not self_entry:
            return None
        state_code = self._proxy_release_state_int(self_entry.get("state_code"))
        combat_busy = bool(self_entry.get("combat_busy"))
        if combat_busy or (state_code in PROXY_RELEASE_BUSY_STATES if state_code is not None else False):
            return {
                "skip": "self_busy",
                "self": str(self.my_scene_id),
                "state": state_code,
                "combat_busy": combat_busy,
            }
        if include_recent_busy:
            last_busy = self_entry.get("last_combat_busy_ts_ms")
            if isinstance(last_busy, int) and now_ms - last_busy < PROXY_AUTO_PUNCH_BUSY_GRACE_MS:
                return {
                    "skip": "self_recent_busy",
                    "self": str(self.my_scene_id),
                    "state": state_code,
                    "age_ms": now_ms - last_busy,
                }
        return None

    @staticmethod
    def _ring_lateral_contact(dx: float, dy: float) -> Optional[Dict[str, object]]:
        abs_x = abs(float(dx))
        abs_y = abs(float(dy))
        gap = abs(abs_x - abs_y)
        if abs_x <= 0.001 or abs_y <= 0.001 or float(dx) * float(dy) <= 0:
            return None
        if 0.88 <= abs_x <= 1.22 and 0.88 <= abs_y <= 1.22 and gap <= 0.22:
            kind = "HOT"
            priority = 0
            score = max(abs(abs_x - 1.0), abs(abs_y - 1.0), gap)
        elif 0.72 <= abs_x <= 1.42 and 0.72 <= abs_y <= 1.42 and gap <= 0.34:
            kind = "DIAG"
            priority = 1
            score = max(abs(abs_x - 1.0), abs(abs_y - 1.0), gap)
        elif 1.55 <= abs_x <= 2.45 and 1.55 <= abs_y <= 2.45 and gap <= 0.5:
            kind = "STAGE"
            priority = 2
            score = max(abs(abs_x - 2.0), abs(abs_y - 2.0), gap)
        elif 0.62 <= abs_x <= 2.2 and 0.62 <= abs_y <= 2.2 and gap <= 0.85:
            kind = "APPROACH"
            priority = 3
            score = max(abs(abs_x - 1.5), abs(abs_y - 1.5), gap)
        else:
            return None
        return {
            "axis": "MAIN_SIDE",
            "kind": kind,
            "priority": priority,
            "score": round(float(score), 4),
        }

    @staticmethod
    def _strict_punch_axis_label(self_x: int, self_y: int, target_x: int, target_y: int) -> str:
        dx = target_x - self_x
        dy = target_y - self_y
        contact = ProxySession._ring_lateral_contact(float(dx), float(dy))
        return "MAIN_SIDE" if contact and int(contact.get("priority") or 0) <= 1 else ""

    @staticmethod
    def _contact_axis_label(self_x: int, self_y: int, target_x: int, target_y: int) -> str:
        dx = target_x - self_x
        dy = target_y - self_y
        contact = ProxySession._ring_lateral_contact(float(dx), float(dy))
        if contact:
            return str(contact.get("axis") or "MAIN_SIDE")
        if dx == 0 and dy == 0:
            return "SAME"
        if abs(dx) <= 1 and abs(dy) <= 1:
            return "NEAR_OFF_AXIS"
        return "FAR"

    @staticmethod
    def _contact_axis_label_float(self_x: float, self_y: float, target_x: float, target_y: float) -> str:
        dx = target_x - self_x
        dy = target_y - self_y
        eps = 0.001
        contact = ProxySession._ring_lateral_contact(dx, dy)
        if contact:
            return str(contact.get("axis") or "MAIN_SIDE")
        if abs(dx) <= 1.0 + eps and abs(dy) <= 1.0 + eps:
            return "NEAR_OFF_AXIS"
        return "FAR"

    @staticmethod
    def _proxy_contact_axis_allowed(axis: str, mode: str) -> bool:
        mode = sanitize_proxy_contact_axis(mode)
        if mode == "main":
            return axis == "MAIN_SIDE"
        if mode == "mirror":
            return False
        if mode == "cardinal":
            return False
        if mode == "all":
            return axis == "MAIN_SIDE"
        return axis == "MAIN_SIDE"

    @staticmethod
    def _proxy_contact_loose_axis(dx: float, dy: float, mode: str) -> Tuple[str, float]:
        candidates: List[Tuple[str, float]] = []
        if sanitize_proxy_contact_axis(mode) in ("main", "both", "all"):
            candidates.append(("MAIN_SIDE_LOOSE", min(max(abs(dx - dy), abs(dx - 1.0)), max(abs(dx - dy), abs(dx + 1.0)))))
        if sanitize_proxy_contact_axis(mode) in ("mirror", "both", "all"):
            candidates.append(("MIRROR_SIDE_LOOSE", min(max(abs(dx + dy), abs(dx - 1.0)), max(abs(dx + dy), abs(dx + 1.0)))))
        if sanitize_proxy_contact_axis(mode) in ("cardinal", "all"):
            candidates.append(
                (
                    "CARDINAL_SIDE_LOOSE",
                    min(
                        max(abs(dx - 1.0), abs(dy)),
                        max(abs(dx + 1.0), abs(dy)),
                        max(abs(dx), abs(dy - 1.0)),
                        max(abs(dx), abs(dy + 1.0)),
                    ),
                )
            )
        if not candidates:
            return "", 999.0
        return min(candidates, key=lambda item: item[1])

    @staticmethod
    def _proxy_contact_path(record: Optional[Dict[str, object]], entry: Optional[Dict[str, object]]) -> Optional[Tuple[int, int, int, int, int]]:
        if record is not None:
            from_x = parse_int_field(record.get("from_x"))
            from_y = parse_int_field(record.get("from_y"))
            to_x = parse_int_field(record.get("x"))
            to_y = parse_int_field(record.get("y"))
            step_ms = parse_int_field(record.get("step_ms"), 0) or 0
            if from_x is not None and from_y is not None and to_x is not None and to_y is not None:
                return int(from_x), int(from_y), int(to_x), int(to_y), int(step_ms)
        if entry is None:
            return None
        x_value = parse_int_field(entry.get("x"))
        y_value = parse_int_field(entry.get("y"))
        if x_value is None or y_value is None:
            return None
        return int(x_value), int(y_value), int(x_value), int(y_value), 0

    @staticmethod
    def _proxy_tuple_point_at_offset(path: Tuple[float, float, float, float, int], offset_ms: int) -> Tuple[float, float]:
        sx0, sy0, sx1, sy1, step_ms = path
        step = max(0, int(step_ms or 0))
        if step <= 0:
            return float(sx1), float(sy1)
        ratio = max(0.0, min(1.0, float(max(0, int(offset_ms))) / float(step)))
        return (
            float(sx0) + (float(sx1) - float(sx0)) * ratio,
            float(sy0) + (float(sy1) - float(sy0)) * ratio,
        )

    def _proxy_precise_precontact_hit(
        self,
        self_path: Tuple[float, float, float, float, int],
        target_path: Tuple[float, float, float, float, int],
        axis_mode: str,
        horizon_ms: int,
    ) -> Optional[Dict[str, object]]:
        horizon = max(0, min(PRECONTACT_MAX_HOT_MS, int(horizon_ms or 0)))
        if horizon <= 0:
            horizon = max(int(self_path[4] or 0), int(target_path[4] or 0), self._movement_step_ms())
            horizon = max(0, min(PRECONTACT_MAX_HOT_MS, horizon))
        if horizon <= 0:
            return None
        offsets = set(range(0, horizon + PRECONTACT_SAMPLE_MS, PRECONTACT_SAMPLE_MS))
        offsets.update((0, 1, 2, 4, 8, 12, 16, 24, 32, horizon))
        for step_ms in (int(self_path[4] or 0), int(target_path[4] or 0)):
            if 0 <= step_ms <= horizon:
                offsets.add(step_ms)
        sorted_offsets = sorted(offset for offset in offsets if 0 <= offset <= horizon)
        hot: Optional[Dict[str, object]] = None
        first_fire_space_ms: Optional[int] = None
        best_near: Optional[Dict[str, object]] = None
        current_sx, current_sy = self._proxy_tuple_point_at_offset(self_path, 0)
        current_tx, current_ty = self._proxy_tuple_point_at_offset(target_path, 0)
        current_dx = current_tx - current_sx
        current_dy = current_ty - current_sy
        for offset_ms in sorted_offsets:
            sx, sy = self._proxy_tuple_point_at_offset(self_path, offset_ms)
            tx, ty = self._proxy_tuple_point_at_offset(target_path, offset_ms)
            dx = tx - sx
            dy = ty - sy
            contact = self._ring_lateral_contact(dx, dy)
            abs_x = abs(dx)
            abs_y = abs(dy)
            lane_gap = abs(abs_x - abs_y)
            if first_fire_space_ms is None and dx * dy > 0 and abs_x <= PRECONTACT_FIRE_MAX_ABS and abs_y <= PRECONTACT_FIRE_MAX_ABS and lane_gap <= PRECONTACT_FIRE_MAX_LANE_GAP:
                first_fire_space_ms = int(offset_ms)
            if contact and self._proxy_contact_axis_allowed(str(contact.get("axis") or ""), axis_mode):
                if int(contact.get("priority") or 99) <= 1:
                    hot = {
                        "offset_ms": int(offset_ms),
                        "axis": str(contact.get("axis") or "MAIN_SIDE"),
                        "ring": contact,
                        "self_xy": [round(sx, 3), round(sy, 3)],
                        "target_xy": [round(tx, 3), round(ty, 3)],
                        "self_tile": [int(round(sx)), int(round(sy))],
                        "target_tile": [int(round(tx)), int(round(ty))],
                        "dx": round(dx, 3),
                        "dy": round(dy, 3),
                        "abs_x": round(abs_x, 3),
                        "abs_y": round(abs_y, 3),
                        "lane_gap": round(lane_gap, 3),
                    }
                    break
            if best_near is None and abs_x <= 2.25 and abs_y <= 2.25 and lane_gap <= 0.65 and dx * dy > 0:
                best_near = {
                    "in_ms": int(offset_ms),
                    "dx": round(dx, 3),
                    "dy": round(dy, 3),
                    "axis": str(contact.get("axis") if contact else "NEAR_SIDE"),
                    "ring": contact,
                }
        if hot is None:
            return None
        hot_eta = max(PRECONTACT_MIN_HOT_MS, int(hot["offset_ms"]))
        desired_fire = max(0, hot_eta - PRECONTACT_LEAD_MS)
        if first_fire_space_ms is not None:
            fire_delay_ms = max(desired_fire, min(first_fire_space_ms, hot_eta))
        else:
            fire_delay_ms = desired_fire
        fire_sx, fire_sy = self._proxy_tuple_point_at_offset(self_path, fire_delay_ms)
        fire_tx, fire_ty = self._proxy_tuple_point_at_offset(target_path, fire_delay_ms)
        fire_dx = fire_tx - fire_sx
        fire_dy = fire_ty - fire_sy
        fire_abs_x = abs(fire_dx)
        fire_abs_y = abs(fire_dy)
        fire_lane_gap = abs(fire_abs_x - fire_abs_y)
        fire_contact = self._ring_lateral_contact(fire_dx, fire_dy)
        fire_contact_ok = fire_contact is not None and int(fire_contact.get("priority") or 99) <= 1 and self._proxy_contact_axis_allowed(str(fire_contact.get("axis") or ""), axis_mode)
        fire_prezone_ok = fire_dx * fire_dy > 0 and fire_abs_x <= PRECONTACT_FIRE_MAX_ABS and fire_abs_y <= PRECONTACT_FIRE_MAX_ABS and fire_lane_gap <= PRECONTACT_FIRE_MAX_LANE_GAP
        if not (fire_contact_ok or fire_prezone_ok):
            return None
        current_dist = max(abs(current_dx), abs(current_dy))
        hot_dist = max(abs(float(hot["dx"])), abs(float(hot["dy"])))
        closing = current_dist - hot_dist
        if closing < -0.05:
            return None
        max_step = max(int(self_path[4] or 0), int(target_path[4] or 0))
        t_pct = int(round((float(hot_eta) / float(max_step)) * 100.0)) if max_step > 0 else 0
        return {
            "kind": "precontact_hot" if fire_delay_ms > 0 else "instant_hot",
            "t_pct": max(0, min(100, t_pct)),
            "axis": str(hot.get("axis") or "MAIN_SIDE"),
            "ring": hot.get("ring"),
            "in_ms": hot_eta,
            "contact_eta_ms": hot_eta,
            "fire_delay_ms": int(fire_delay_ms),
            "lead_ms": max(0, hot_eta - int(fire_delay_ms)),
            "self_xy": [round(fire_sx, 3), round(fire_sy, 3)],
            "target_xy": [round(fire_tx, 3), round(fire_ty, 3)],
            "hot_self_xy": hot.get("self_xy"),
            "hot_target_xy": hot.get("target_xy"),
            "self_tile": [int(round(fire_sx)), int(round(fire_sy))],
            "target_tile": [int(round(fire_tx)), int(round(fire_ty))],
            "dx": round(fire_dx, 3),
            "dy": round(fire_dy, 3),
            "hot_dx": hot.get("dx"),
            "hot_dy": hot.get("dy"),
            "current_dx": round(current_dx, 3),
            "current_dy": round(current_dy, 3),
            "closing": round(closing, 3),
            "step_ms": max_step,
            "near": best_near,
        }

    def _proxy_contact_sweep_hit(
        self,
        self_path: Tuple[int, int, int, int, int],
        target_path: Tuple[int, int, int, int, int],
        axis_mode: str,
    ) -> Optional[Dict[str, object]]:
        sx0, sy0, sx1, sy1, self_step_ms = self_path
        tx0, ty0, tx1, ty1, target_step_ms = target_path
        horizon_ms = max(int(self_step_ms or 0), int(target_step_ms or 0), self._movement_step_ms())
        precise = self._proxy_precise_precontact_hit(self_path, target_path, axis_mode, horizon_ms)
        if precise is not None:
            return precise
        max_step = max(int(self_step_ms or 0), int(target_step_ms or 0), self._movement_step_ms())
        if max_step <= 0:
            return None
        offsets = set(range(0, max_step + PRECONTACT_SAMPLE_MS, PRECONTACT_SAMPLE_MS))
        offsets.update((0, 1, 2, 4, 8, 12, 16, 24, 32, max_step))
        best_near: Optional[Dict[str, object]] = None
        for offset_ms in sorted(offset for offset in offsets if 0 <= int(offset) <= max_step):
            sx, sy = self._proxy_tuple_point_at_offset(self_path, int(offset_ms))
            tx, ty = self._proxy_tuple_point_at_offset(target_path, int(offset_ms))
            axis = self._contact_axis_label_float(sx, sy, tx, ty)
            tile_sx = int(round(sx))
            tile_sy = int(round(sy))
            tile_tx = int(round(tx))
            tile_ty = int(round(ty))
            tile_axis = self._strict_punch_axis_label(tile_sx, tile_sy, tile_tx, tile_ty)
            dx = tx - sx
            dy = ty - sy
            contact = self._ring_lateral_contact(dx, dy)
            near = abs(dx) <= 2.25 and abs(dy) <= 2.25
            if near and best_near is None:
                best_near = {
                    "in_ms": int(offset_ms),
                    "t_pct": int(round(float(offset_ms) * 100.0 / float(max_step))),
                    "dx": round(dx, 3),
                    "dy": round(dy, 3),
                    "axis": axis,
                    "ring": contact,
                }
            if contact and self._proxy_contact_axis_allowed(str(contact.get("axis") or axis), axis_mode) and int(contact.get("priority") or 99) <= 1:
                fire_delay_ms = max(0, int(offset_ms) - PRECONTACT_LEAD_MS)
                fire_sx, fire_sy = self._proxy_tuple_point_at_offset(self_path, fire_delay_ms)
                fire_tx, fire_ty = self._proxy_tuple_point_at_offset(target_path, fire_delay_ms)
                fire_contact = self._ring_lateral_contact(fire_tx - fire_sx, fire_ty - fire_sy)
                if fire_delay_ms > 0 and (fire_contact is None or int(fire_contact.get("priority") or 99) > 1):
                    fire_delay_ms = int(offset_ms)
                return {
                    "kind": f"sweep_{str(contact.get('kind') or 'RING').lower()}",
                    "t_pct": int(round(float(offset_ms) * 100.0 / float(max_step))),
                    "axis": str(contact.get("axis") or tile_axis or axis),
                    "ring": contact,
                    "in_ms": int(offset_ms),
                    "contact_eta_ms": int(offset_ms),
                    "contact_in_ms": int(offset_ms),
                    "fire_delay_ms": int(fire_delay_ms),
                    "lead_ms": max(0, int(offset_ms) - int(fire_delay_ms)),
                    "self_xy": [round(fire_sx, 3), round(fire_sy, 3)],
                    "target_xy": [round(fire_tx, 3), round(fire_ty, 3)],
                    "hot_self_xy": [round(sx, 3), round(sy, 3)],
                    "hot_target_xy": [round(tx, 3), round(ty, 3)],
                    "self_tile": [int(round(fire_sx)), int(round(fire_sy))],
                    "target_tile": [int(round(fire_tx)), int(round(fire_ty))],
                    "dx": round(fire_tx - fire_sx, 3),
                    "dy": round(fire_ty - fire_sy, 3),
                    "hot_dx": round(dx, 3),
                    "hot_dy": round(dy, 3),
                    "step_ms": max_step,
                    "near": best_near,
                }
        return None

    def _build_proxy_contact_payload(self, selected_targets: List[str], frames_by_target: Dict[str, bytes], copies: int) -> bytes:
        payload = bytearray()
        for _copy_idx in range(copies):
            for target_id in selected_targets:
                frame = frames_by_target.get(target_id)
                if frame:
                    payload.extend(frame)
        return bytes(payload)

    def _send_proxy_contact_batch(
        self,
        selected_targets: List[str],
        frames_by_target: Dict[str, bytes],
        copies: int,
        delay_ms: int,
        ladder_index: int,
        ladder_total: int,
        source_base: str = "proxy_contact",
        burst_id: Optional[int] = None,
    ) -> bool:
        now_ms = int(time.time() * 1000)
        if burst_id is not None and burst_id != self.proxy_contact_burst_id:
            return False
        if now_ms < self.proxy_contact_inhibit_until_ms:
            self.proxy_contact_counter_skips += 1
            self.proxy_contact_counter_last_debug = {
                "skip": "post_resolve_inhibit",
                "source": source_base,
                "delay_ms": delay_ms,
                "inhibit_ms": self.proxy_contact_inhibit_until_ms - now_ms,
            }
            return False
        if not self.crypto_active or self.server_encrypt is None:
            return False
        release_source = "release" in source_base
        busy_block = self._proxy_auto_punch_block(now_ms, include_recent_busy=not release_source)
        if busy_block is not None:
            debug = {"source": source_base, "delay_ms": delay_ms, **busy_block}
            if release_source:
                self.proxy_release_counter_skips += 1
                self.proxy_release_counter_last_debug = debug
            elif "scan" in source_base:
                self.proxy_contact_scan_skips += 1
                self.proxy_contact_scan_last_debug = debug
            else:
                self.proxy_contact_counter_skips += 1
                self.proxy_contact_counter_last_debug = debug
            return False
        payload = self._build_proxy_contact_payload(selected_targets, frames_by_target, copies)
        if not payload:
            return False
        try:
            with self.upstream_lock:
                encrypted = self.server_encrypt.crypt(payload)
                self.remote_sock.sendall(encrypted)
        except (ConnectionError, OSError) as exc:
            self.last_error = f"PROXY_CONTACT failed: {exc}"
            self.log(self.last_error, console=self.config.verbose)
            return False
        total_copies = copies * len(selected_targets)
        self.punches_injected += total_copies
        source = source_base if ladder_total <= 1 else f"{source_base}_ladder"
        for copy_idx in range(copies):
            for target_id in selected_targets:
                self._record_punch_send(
                    target_id=target_id,
                    source=source,
                    copy_index=copy_idx + 1,
                    copy_total=copies,
                    move_attached=True,
                )
        if self.config.verbose:
            self.log(
                f"{source_base.upper()} batch targets={','.join(selected_targets)} copies={copies} delay={delay_ms}ms ladder={ladder_index}/{ladder_total}",
                console=True,
            )
        self.proxy_contact_inhibit_until_ms = max(
            self.proxy_contact_inhibit_until_ms,
            now_ms + PROXY_AUTO_PUNCH_POST_SEND_INHIBIT_MS,
        )
        self.proxy_contact_scan_scheduled_at_by_key.clear()
        self.proxy_contact_scan_burst_until_ms = max(
            self.proxy_contact_scan_burst_until_ms,
            now_ms + PROXY_AUTO_PUNCH_POST_SEND_INHIBIT_MS,
        )
        self.proxy_contact_burst_id += 1
        return True

    def _queue_proxy_contact_ladder(
        self,
        selected_targets: List[str],
        frames_by_target: Dict[str, bytes],
        copies: int,
        ladder_ms: int,
        ladder_steps: int,
        source_base: str = "proxy_contact",
    ) -> int:
        ladder_ms = sanitize_proxy_contact_ladder_ms(ladder_ms)
        ladder_steps = sanitize_proxy_contact_ladder_steps(ladder_steps)
        burst_id = self.proxy_contact_burst_id
        if ladder_ms <= 0 or ladder_steps <= 1:
            return 1 if self._send_proxy_contact_batch(selected_targets, frames_by_target, copies, 0, 1, 1, source_base, burst_id) else 0
        scheduled = 0
        for idx in range(ladder_steps):
            delay_ms = int(round(float(idx) * float(ladder_ms) / float(max(1, ladder_steps - 1))))
            if delay_ms <= 0:
                if not self._send_proxy_contact_batch(selected_targets, frames_by_target, copies, 0, idx + 1, ladder_steps, source_base, burst_id):
                    return scheduled
            else:
                timer = threading.Timer(
                    delay_ms / 1000.0,
                    self._send_proxy_contact_batch,
                    args=(selected_targets, frames_by_target, copies, delay_ms, idx + 1, ladder_steps, source_base, burst_id),
                )
                timer.daemon = True
                timer.start()
            scheduled += 1
        return scheduled

    def _record_proxy_contact_scheduled_skip(
        self,
        reason: str,
        source_base: str,
        target_id: str,
        delay_ms: int,
        extra: Optional[Dict[str, object]] = None,
    ) -> None:
        debug = {
            "skip": reason,
            "source": source_base,
            "target": target_id,
            "delay_ms": delay_ms,
            **(extra or {}),
        }
        if "counter" in source_base:
            self.proxy_contact_counter_skips += 1
            self.proxy_contact_counter_last_debug = debug
        else:
            self.proxy_contact_scan_skips += 1
            self.proxy_contact_scan_last_debug = debug
        self.registry.add_event(
            {
                "type": "PROXY_CONTACT_PRECONTACT_SKIP",
                "session_id": self.session_id,
                "reason": reason,
                "source": source_base,
                "target_id": target_id,
                "delay_ms": delay_ms,
                **(extra or {}),
            }
        )

    def _send_proxy_contact_scheduled_batch(
        self,
        burst_id: int,
        original_target_id: str,
        fallback_frames_by_target: Dict[str, bytes],
        copies: int,
        delay_ms: int,
        ladder_index: int,
        ladder_total: int,
        source_base: str,
        key: str,
        due_ms: int,
    ) -> bool:
        now_ms = int(time.time() * 1000)
        if burst_id != self.proxy_contact_burst_id:
            self._record_proxy_contact_scheduled_skip(
                "burst_cancelled",
                source_base,
                original_target_id,
                delay_ms,
                {"active_burst_id": self.proxy_contact_burst_id, "burst_id": burst_id, "key": key},
            )
            return False
        if now_ms < self.proxy_contact_inhibit_until_ms:
            self._record_proxy_contact_scheduled_skip(
                "post_resolve_inhibit",
                source_base,
                original_target_id,
                delay_ms,
                {"inhibit_ms": self.proxy_contact_inhibit_until_ms - now_ms, "key": key},
            )
            return False
        if not self.config.proxy_contact_counter or not self.crypto_active or self.server_encrypt is None:
            self._record_proxy_contact_scheduled_skip(
                "scheduled_gate",
                source_base,
                original_target_id,
                delay_ms,
                {"crypto": self.crypto_active, "key": key},
            )
            return False
        late_ms = now_ms - int(due_ms)
        if late_ms > 120:
            self._record_proxy_contact_scheduled_skip(
                "timer_late",
                source_base,
                original_target_id,
                delay_ms,
                {"late_ms": late_ms, "key": key},
            )
            return False
        lead_ms = self._proxy_contact_prefire_lead_ms()
        guard_horizon_ms = max(170, lead_ms + 150)
        guard_fire_ms = max(130, lead_ms + 80)
        selected_targets: List[str] = []
        frames_by_target: Dict[str, bytes] = {}
        guard_debug: Dict[str, object] = {}
        try:
            candidates, guard_debug = self._proxy_pick_contact_targets(
                now_ms,
                guard_horizon_ms,
                guard_fire_ms,
                1,
            )
            candidates = self._compatible_contact_candidates(candidates, 1)
        except Exception as exc:
            candidates = []
            guard_debug = {"skip": "guard_pick_error", "error": str(exc)}
        if candidates:
            chosen = candidates[0]
            chosen_id = normalize_target_id(chosen.get("id"))
            if chosen_id is not None and chosen_id != str(self.my_scene_id or ""):
                selected_targets = [chosen_id]
                try:
                    frames_by_target = {chosen_id: build_punch_frame(chosen_id)}
                except ValueError:
                    selected_targets = []
                    frames_by_target = {}
        if not selected_targets:
            fallback_id = normalize_target_id(original_target_id)
            if fallback_id is not None and fallback_id in fallback_frames_by_target and delay_ms <= 45:
                selected_targets = [fallback_id]
                frames_by_target = {fallback_id: fallback_frames_by_target[fallback_id]}
                guard_debug = {"fallback": "original_target_urgent", **guard_debug}
        if not selected_targets:
            self._record_proxy_contact_scheduled_skip(
                "guard_no_target",
                source_base,
                original_target_id,
                delay_ms,
                {"key": key, "guard": guard_debug},
            )
            return False
        ok = self._send_proxy_contact_batch(
            selected_targets,
            frames_by_target,
            copies,
            delay_ms,
            ladder_index,
            ladder_total,
            source_base,
            burst_id,
        )
        if ok:
            self.registry.add_event(
                {
                    "type": "PROXY_CONTACT_PRECONTACT_FIRE",
                    "session_id": self.session_id,
                    "source": source_base,
                    "target_id": selected_targets[0],
                    "original_target_id": original_target_id,
                    "delay_ms": delay_ms,
                    "ladder_index": ladder_index,
                    "ladder_total": ladder_total,
                    "key": key,
                    "guard": guard_debug,
                }
            )
            return True
        self._record_proxy_contact_scheduled_skip(
            "send_failed",
            source_base,
            original_target_id,
            delay_ms,
            {"key": key, "targets": selected_targets, "guard": guard_debug},
        )
        return False

    def _packet_brain_schedule_offsets(self, base_offsets_ms: Tuple[int, ...]) -> List[int]:
        offsets = {max(0, int(value)) for value in base_offsets_ms}
        ladder_ms = sanitize_packet_brain_ladder_ms(self.config.packet_brain_ladder_ms)
        ladder_steps = sanitize_packet_brain_ladder_steps(self.config.packet_brain_ladder_steps)
        if ladder_ms > 0 and ladder_steps > 1:
            for idx in range(ladder_steps):
                offsets.add(int(round(float(idx) * float(ladder_ms) / float(max(1, ladder_steps - 1)))))
        return sorted(offsets)

    def _packet_brain_note_skip(self, reason: str, debug: Optional[Dict[str, object]] = None) -> None:
        self.packet_brain_skips += 1
        self.packet_brain_last_debug = {"skip": reason, **(debug or {})}

    def _packet_brain_append_plain(
        self,
        out: bytearray,
        selected_targets: List[str],
        frames_by_target: Dict[str, bytes],
        copies: int,
        source: str,
    ) -> int:
        total = 0
        for copy_idx in range(copies):
            for target_id in selected_targets:
                frame = frames_by_target.get(target_id)
                if not frame:
                    continue
                out.extend(frame)
                total += 1
                self._record_punch_send(
                    target_id=target_id,
                    source=source,
                    copy_index=copy_idx + 1,
                    copy_total=copies,
                    move_attached=True,
                )
        if total > 0:
            self.punches_injected += total
        return total

    def _packet_brain_send_scheduled_batch(
        self,
        burst_id: int,
        selected_targets: List[str],
        frames_by_target: Dict[str, bytes],
        copies: int,
        delay_ms: int,
        ladder_index: int,
        ladder_total: int,
        source_base: str,
    ) -> bool:
        now_ms = int(time.time() * 1000)
        if burst_id != self.packet_brain_burst_id:
            self._packet_brain_note_skip(
                "burst_cancelled",
                {"source": source_base, "delay_ms": delay_ms, "burst_id": burst_id, "active_burst_id": self.packet_brain_burst_id},
            )
            return False
        if now_ms < self.packet_brain_inhibit_until_ms:
            self._packet_brain_note_skip(
                "post_resolve_inhibit",
                {"source": source_base, "delay_ms": delay_ms, "inhibit_ms": self.packet_brain_inhibit_until_ms - now_ms},
            )
            return False
        ok = self._send_proxy_contact_batch(
            selected_targets,
            frames_by_target,
            copies,
            delay_ms,
            ladder_index,
            ladder_total,
            source_base,
        )
        if ok:
            self.packet_brain_burst_id += 1
            self.packet_brain_inhibit_until_ms = max(
                self.packet_brain_inhibit_until_ms,
                now_ms + PROXY_AUTO_PUNCH_POST_SEND_INHIBIT_MS,
            )
        return ok

    def _packet_brain_cut_after_resolve(self, evt: Dict[str, object], now_ms: int) -> None:
        if not self.my_scene_id:
            return
        my_scene_id = str(self.my_scene_id)
        if my_scene_id not in (str(evt.get("atk_id") or ""), str(evt.get("def_id") or "")):
            return
        if self.config.proxy_contact_counter:
            self.proxy_contact_burst_id += 1
            self.proxy_release_counter_burst_id += 1
            self.proxy_contact_inhibit_until_ms = max(
                self.proxy_contact_inhibit_until_ms,
                now_ms + PROXY_CONTACT_POST_RESOLVE_INHIBIT_MS,
            )
            self.proxy_contact_scan_scheduled_at_by_key.clear()
            self.proxy_contact_scan_burst_until_ms = max(
                self.proxy_contact_scan_burst_until_ms,
                now_ms + PROXY_CONTACT_POST_RESOLVE_INHIBIT_MS,
            )
            self.proxy_contact_counter_last_debug = {
                "cut": "self_resolve",
                "inhibit_ms": PROXY_CONTACT_POST_RESOLVE_INHIBIT_MS,
                "burst_id": self.proxy_contact_burst_id,
                "atk_id": evt.get("atk_id"),
                "def_id": evt.get("def_id"),
                "previous": self.proxy_contact_counter_last_debug,
            }
            self.registry.add_event(
                {
                    "type": "PROXY_CONTACT_CUT",
                    "session_id": self.session_id,
                    "reason": "self_resolve",
                    "inhibit_ms": PROXY_CONTACT_POST_RESOLVE_INHIBIT_MS,
                    "atk_id": evt.get("atk_id"),
                    "def_id": evt.get("def_id"),
                }
            )
        if self.config.packet_brain:
            self.packet_brain_burst_id += 1
            self.packet_brain_inhibit_until_ms = max(
                self.packet_brain_inhibit_until_ms,
                now_ms + PACKET_BRAIN_POST_RESOLVE_INHIBIT_MS,
            )
            self.packet_brain_episode_until_ms = max(
                self.packet_brain_episode_until_ms,
                now_ms + PACKET_BRAIN_POST_RESOLVE_INHIBIT_MS,
            )
            self.packet_brain_last_debug = {
                "cut": "self_resolve",
                "inhibit_ms": PACKET_BRAIN_POST_RESOLVE_INHIBIT_MS,
                "burst_id": self.packet_brain_burst_id,
                "atk_id": evt.get("atk_id"),
                "def_id": evt.get("def_id"),
                "previous": self.packet_brain_last_debug,
            }
            self.registry.add_event(
                {
                    "type": "PACKET_BRAIN_CUT",
                    "session_id": self.session_id,
                    "reason": "self_resolve",
                    "inhibit_ms": PACKET_BRAIN_POST_RESOLVE_INHIBIT_MS,
                    "atk_id": evt.get("atk_id"),
                    "def_id": evt.get("def_id"),
                }
            )

    def _packet_brain_fire_candidates(
        self,
        now_ms: int,
        reason: str,
        candidates: List[Dict[str, object]],
        debug: Dict[str, object],
        base_offsets_ms: Tuple[int, ...],
        out: Optional[bytearray] = None,
    ) -> bool:
        if not self.config.packet_brain:
            return False
        if not self.crypto_active or self.server_encrypt is None:
            self._packet_brain_note_skip("gate", {"reason": reason, "crypto": self.crypto_active})
            return False
        if now_ms < self.packet_brain_inhibit_until_ms:
            self._packet_brain_note_skip(
                "post_resolve_inhibit",
                {"reason": reason, "inhibit_ms": self.packet_brain_inhibit_until_ms - now_ms},
            )
            return False
        busy_block = self._proxy_auto_punch_block(now_ms, include_recent_busy=True)
        if busy_block is not None:
            self._packet_brain_note_skip("self_busy", {"reason": reason, **busy_block})
            return False
        if not candidates:
            if now_ms - self.packet_brain_episode_seen_ms > PACKET_BRAIN_EPISODE_RESET_MS:
                self.packet_brain_episode_key = ""
                self.packet_brain_episode_until_ms = 0
            self._packet_brain_note_skip("no_candidate", {"reason": reason, **debug})
            return False
        selected_candidates = self._compatible_contact_candidates(candidates, self._packet_brain_max_targets())
        selected_targets: List[str] = []
        for item in selected_candidates:
            target_id = normalize_target_id(item.get("id"))
            if target_id is not None and target_id != str(self.my_scene_id or "") and target_id not in selected_targets:
                selected_targets.append(target_id)
        if not selected_targets:
            self._packet_brain_note_skip("no_valid_targets", {"reason": reason, "candidates": candidates[:6], **debug})
            return False
        best = selected_candidates[0]
        contact = best.get("contact") or {}
        key = ":".join(
            [
                ",".join(selected_targets),
                str(contact.get("kind") or best.get("kind") or ""),
                str(contact.get("axis") or best.get("axis") or ""),
                json.dumps(contact.get("self_tile") or contact.get("self_xy") or debug.get("self_path") or [], separators=(",", ":")),
                json.dumps(contact.get("target_tile") or contact.get("target_xy") or best.get("target_path") or [], separators=(",", ":")),
            ]
        )
        self.packet_brain_episode_seen_ms = now_ms
        if key == self.packet_brain_episode_key and now_ms < self.packet_brain_episode_until_ms:
            self._packet_brain_note_skip(
                "episode_latched",
                {
                    "reason": reason,
                    "target": selected_targets[0],
                    "until_ms": self.packet_brain_episode_until_ms - now_ms,
                    "key": key,
                    **debug,
                },
            )
            return False
        last_key_at = int(self.packet_brain_last_key_at.get(key) or 0)
        if last_key_at and now_ms - last_key_at < PACKET_BRAIN_KEY_TTL_MS:
            self._packet_brain_note_skip(
                "duplicate_key",
                {"reason": reason, "target": selected_targets[0], "age_ms": now_ms - last_key_at, "key": key, **debug},
            )
            return False
        try:
            frames_by_target = {target_id: build_punch_frame(target_id) for target_id in selected_targets}
        except ValueError:
            self._packet_brain_note_skip("invalid_frame", {"reason": reason, "targets": selected_targets, **debug})
            return False
        copies = sanitize_proxy_contact_copies(self.config.packet_brain_copies)
        fire_delay_ms = max(0, parse_int_field(contact.get("fire_delay_ms"), 0) or 0)
        offsets = [fire_delay_ms + int(offset) for offset in self._packet_brain_schedule_offsets(base_offsets_ms)]
        self.packet_brain_burst_id += 1
        burst_id = self.packet_brain_burst_id
        scheduled = 0
        immediate_sent = 0
        for index, offset_ms in enumerate(offsets, start=1):
            source = "packet_brain" if len(offsets) <= 1 else "packet_brain_window"
            if offset_ms <= 0 and out is not None:
                immediate_sent += self._packet_brain_append_plain(out, selected_targets, frames_by_target, copies, source)
                scheduled += 1
            elif offset_ms <= 0:
                if self._packet_brain_send_scheduled_batch(burst_id, selected_targets, frames_by_target, copies, 0, index, len(offsets), source):
                    scheduled += 1
            else:
                timer = threading.Timer(
                    offset_ms / 1000.0,
                    self._packet_brain_send_scheduled_batch,
                    args=(burst_id, selected_targets, frames_by_target, copies, int(offset_ms), index, len(offsets), source),
                )
                timer.daemon = True
                timer.start()
                scheduled += 1
        if scheduled <= 0:
            self._packet_brain_note_skip("send_failed", {"reason": reason, "targets": selected_targets, **debug})
            return False
        if immediate_sent > 0:
            self.packet_brain_burst_id += 1
            self.packet_brain_inhibit_until_ms = max(
                self.packet_brain_inhibit_until_ms,
                now_ms + PROXY_AUTO_PUNCH_POST_SEND_INHIBIT_MS,
            )
            self.proxy_contact_inhibit_until_ms = max(
                self.proxy_contact_inhibit_until_ms,
                now_ms + PROXY_AUTO_PUNCH_POST_SEND_INHIBIT_MS,
            )
        if len(self.packet_brain_last_key_at) > 256:
            cutoff = now_ms - 1200
            self.packet_brain_last_key_at = {item_key: item_at for item_key, item_at in self.packet_brain_last_key_at.items() if item_at >= cutoff}
        self.packet_brain_last_key_at[key] = now_ms
        self.packet_brain_episode_key = key
        self.packet_brain_episode_until_ms = now_ms + max(PACKET_BRAIN_EPISODE_HOLD_MS, (max(offsets) if offsets else 0) + 260)
        self.packet_brain_last_key = key
        self.packet_brain_fires += 1
        self.packet_brain_last_fire_at_ms = now_ms
        self.packet_brain_last_target = selected_targets[0]
        self.packet_brain_last_reason = (
            f"{reason} target={selected_targets[0]} fire={fire_delay_ms}ms contact={contact.get('contact_eta_ms', contact.get('in_ms', '--'))}ms "
            f"axis={contact.get('axis') or best.get('axis') or '--'} fanout={len(selected_targets)} offsets={len(offsets)}"
        )
        self.packet_brain_last_debug = {
            "reason": reason,
            "targets": selected_targets,
            "copies": copies,
            "fire_delay_ms": fire_delay_ms,
            "contact_eta_ms": contact.get("contact_eta_ms", contact.get("in_ms")),
            "offsets_ms": offsets,
            "scheduled": scheduled,
            "immediate_sent": immediate_sent,
            "key": key,
            "burst_id": burst_id,
            "candidate": best,
            **debug,
        }
        self.registry.add_event(
            {
                "type": "PACKET_BRAIN_FIRE",
                "session_id": self.session_id,
                "target_id": selected_targets[0],
                "targets": selected_targets,
                "reason": self.packet_brain_last_reason,
                "copies": copies,
                "fire_delay_ms": fire_delay_ms,
                "contact_eta_ms": contact.get("contact_eta_ms", contact.get("in_ms")),
                "offsets_ms": offsets,
                "scheduled": scheduled,
                "immediate_sent": immediate_sent,
                "candidates": candidates[:6],
            }
        )
        return True

    def _packet_brain_fire_from_roster(
        self,
        now_ms: int,
        reason: str,
        offsets_ms: Tuple[int, ...],
        horizon_ms: Optional[int] = None,
        fire_ahead_ms: Optional[int] = None,
    ) -> bool:
        self.maybe_refresh_from_board(now_ms)
        try:
            selected_candidates, debug = self._proxy_pick_contact_targets(
                now_ms,
                horizon_ms if horizon_ms is not None else self._adaptive_contact_horizon_ms(),
                fire_ahead_ms if fire_ahead_ms is not None else self._adaptive_contact_fire_ahead_ms(),
                self._packet_brain_max_targets(),
            )
        except Exception as exc:
            self._packet_brain_note_skip("pick_error", {"reason": reason, "error": str(exc)})
            return False
        return self._packet_brain_fire_candidates(now_ms, reason, selected_candidates, debug, offsets_ms)

    @staticmethod
    def _proxy_release_state_int(value: object) -> Optional[int]:
        parsed = parse_int_field(value)
        return int(parsed) if parsed is not None else None

    @classmethod
    def _proxy_release_busy_state(cls, value: object) -> bool:
        parsed = cls._proxy_release_state_int(value)
        return parsed in PROXY_RELEASE_BUSY_STATES if parsed is not None else False

    @classmethod
    def _proxy_release_ready_state(cls, value: object) -> bool:
        parsed = cls._proxy_release_state_int(value)
        return parsed in PROXY_RELEASE_READY_STATES if parsed is not None else False

    @classmethod
    def _proxy_release_combat_busy(cls, combat_state: object) -> bool:
        if not isinstance(combat_state, dict):
            return False
        state_value = cls._proxy_release_state_int(combat_state.get("state"))
        return bool(
            parse_bool(combat_state.get("attack"))
            or parse_bool(combat_state.get("react"))
            or parse_bool(combat_state.get("busy"))
            or (state_value in PROXY_RELEASE_BUSY_STATES if state_value is not None else False)
        )

    @classmethod
    def _proxy_release_combat_ready(cls, combat_state: object) -> bool:
        if not isinstance(combat_state, dict):
            return False
        state_value = cls._proxy_release_state_int(combat_state.get("state"))
        if parse_bool(combat_state.get("attack")) or parse_bool(combat_state.get("react")) or parse_bool(combat_state.get("busy")):
            return False
        if state_value is not None and state_value in PROXY_RELEASE_BUSY_STATES:
            return False
        if parse_bool(combat_state.get("free")):
            return True
        return state_value in PROXY_RELEASE_READY_STATES if state_value is not None else False

    @classmethod
    def _proxy_release_ready_delay_from_combat(cls, combat_state: object) -> int:
        if not isinstance(combat_state, dict) or not cls._proxy_release_combat_busy(combat_state):
            return 999999
        try:
            progress = float(combat_state.get("progress") or 0.0)
        except (TypeError, ValueError):
            progress = 0.0
        progress = max(0.0, min(1.0, progress))
        try:
            total = int(float(combat_state.get("total") or 0))
        except (TypeError, ValueError):
            total = 0
        try:
            frame = int(float(combat_state.get("frame") or 0))
        except (TypeError, ValueError):
            frame = 0
        if total < 1:
            total = 6
        frame = max(0, min(total, frame))
        duration_ms = float(total) * 16.0
        if duration_ms < 72.0:
            duration_ms = 72.0
        elif duration_ms > 240.0:
            duration_ms = 240.0
        if parse_bool(combat_state.get("attack")):
            threshold = 0.72
        elif parse_bool(combat_state.get("react")):
            threshold = 0.78
        else:
            threshold = 0.74
        if progress >= threshold or total - frame <= 2:
            return 0
        return max(0, min(180, int(round(duration_ms * (threshold - progress)))))

    def _proxy_release_actor_path(self, entry: Optional[Dict[str, object]], now_ms: int) -> Optional[Dict[str, object]]:
        if not entry:
            return None
        to_x = parse_int_field(entry.get("x"))
        to_y = parse_int_field(entry.get("y"))
        if to_x is None or to_y is None:
            return None
        from_x = parse_int_field(entry.get("prev_x"))
        from_y = parse_int_field(entry.get("prev_y"))
        if from_x is None or from_y is None:
            from_x = to_x
            from_y = to_y
        last_move_ts = entry.get("last_move_ts_ms")
        start_ms = int(last_move_ts) if isinstance(last_move_ts, int) else now_ms
        step_ms = parse_int_field(entry.get("step_ms"), 0) or 0
        if step_ms < 80 or step_ms > 1600:
            step_ms = 0
        end_ms = start_ms + int(step_ms)
        if step_ms <= 0 or now_ms > end_ms + 260:
            from_x = to_x
            from_y = to_y
            start_ms = now_ms
            end_ms = now_ms
        return {
            "from_x": float(from_x),
            "from_y": float(from_y),
            "to_x": float(to_x),
            "to_y": float(to_y),
            "start_ms": int(start_ms) - self._get_half_rtt_ms(),  # Contact V5 Fix 2: compensate for network delay
            "end_ms": int(end_ms) - self._get_half_rtt_ms(),      # movement started on server half_rtt ago
            "step_ms": int(step_ms),
            "moving": int(from_x) != int(to_x) or int(from_y) != int(to_y),
        }

    def _predict_next_step_path(self, scene_id: str, current_path: Dict[str, object], now_ms: int) -> Optional[Dict[str, object]]:
        """Contact V5 Fix 5: predict next step if direction is consistent and current step nearly done."""
        if not current_path or not current_path.get("moving"):
            return None
        end_ms = int(current_path.get("end_ms") or now_ms)
        step_ms = int(current_path.get("step_ms") or 0)
        if step_ms <= 0:
            return None
        # Only predict when step is >75% complete
        elapsed = now_ms - int(current_path.get("start_ms") or now_ms)
        if elapsed < step_ms * 0.75:
            return None
        hist = self.target_direction_history.get(scene_id)
        if not hist or len(hist) < 2:
            return None
        # Check if last 2 orientations are the same (consistent direction)
        if hist[-1] != hist[-2]:
            return None
        orientation = hist[-1]
        dx, dy = MOVE_DIR.get(orientation, (0, 0))
        if dx == 0 and dy == 0:
            return None
        to_x = int(current_path.get("to_x") or 0)
        to_y = int(current_path.get("to_y") or 0)
        predicted_x = to_x + dx
        predicted_y = to_y + dy
        predicted_start = end_ms
        predicted_end = end_ms + step_ms
        return {
            "from_x": float(to_x),
            "from_y": float(to_y),
            "to_x": float(predicted_x),
            "to_y": float(predicted_y),
            "start_ms": predicted_start,
            "end_ms": predicted_end,
            "step_ms": step_ms,
            "moving": True,
            "predicted": True,
        }

    # =========================================================================
    # Contact V6: PRE-QUEUE PUNCH SYSTEM
    # =========================================================================
    def _prequeue_punch_on_step(self, step_records: List[Dict[str, object]], now_ms: int) -> None:
        """Called on every opcode 182. Check if any step creates future diagonal contact."""
        if not self.my_scene_id or not self.crypto_active or self.server_encrypt is None:
            return
        if not self.config.prequeue_punch:
            return
        # Only fire in confirmed Ring matches (after seeing at least one combat resolve)
        if not self.has_seen_ring_resolve:
            return
        # Don't fire during inhibit
        if now_ms < self.proxy_contact_inhibit_until_ms:
            return

        my_id = str(self.my_scene_id)
        my_entry = self.scene_roster.get(my_id)
        if not my_entry:
            return

        my_x = parse_int_field(my_entry.get("x"))
        my_y = parse_int_field(my_entry.get("y"))
        if my_x is None or my_y is None:
            return

        my_step_ms = parse_int_field(my_entry.get("step_ms"), 0) or 0
        my_last_move = my_entry.get("last_move_ts_ms")
        my_moving = isinstance(my_last_move, int) and my_step_ms > 0 and now_ms < my_last_move + my_step_ms + 100

        # My previous position (where I was before this step)
        my_prev_x = parse_int_field(my_entry.get("prev_x"))
        my_prev_y = parse_int_field(my_entry.get("prev_y"))
        if my_prev_x is None:
            my_prev_x = my_x
        if my_prev_y is None:
            my_prev_y = my_y

        half_rtt = self._get_half_rtt_ms()

        for record in step_records:
            scene_id = str(record.get("scene_id") or "")
            if not scene_id or not self.is_probable_ring_scene_id(scene_id):
                continue

            target_dest_x = int(record.get("x") or 0)
            target_dest_y = int(record.get("y") or 0)
            step_ms = int(record.get("step_ms") or 0)
            if step_ms < 80 or step_ms > 1600:
                continue

            if scene_id == my_id:
                # WE are moving. Check if our destination is diagonal to any opponent's CURRENT position.
                for opp_id, opp_entry in list(self.scene_roster.items()):
                    opp_id_str = str(opp_id)
                    if opp_id_str == my_id or not self.is_probable_ring_scene_id(opp_id_str):
                        continue
                    # Only target players seen in the last 4 seconds to avoid ghost targeting from previous rooms
                    opp_last_seen = opp_entry.get("last_seen_ts_ms")
                    if opp_last_seen is None or now_ms - opp_last_seen > 4000:
                        continue
                    opp_x = parse_int_field(opp_entry.get("x"))
                    opp_y = parse_int_field(opp_entry.get("y"))
                    if opp_x is None or opp_y is None:
                        continue
                    # Our destination vs opponent's current position
                    if self._punch_lateral_xy(target_dest_x, target_dest_y, opp_x, opp_y):
                        self._prequeue_schedule_fire(opp_id_str, step_ms, half_rtt, now_ms,
                            target_dest_x, target_dest_y, opp_x, opp_y, "self_into_opp")
                        break  # one prequeue per 182
            else:
                # OPPONENT is moving. Check if their destination is diagonal to our position.
                opp_entry = self.scene_roster.get(scene_id)
                if opp_entry:
                    opp_last_seen = opp_entry.get("last_seen_ts_ms")
                    if opp_last_seen is not None and now_ms - opp_last_seen > 4000:
                        continue
                # Case A: our current position (we're stationary)
                if self._punch_lateral_xy(my_x, my_y, target_dest_x, target_dest_y):
                    self._prequeue_schedule_fire(scene_id, step_ms, half_rtt, now_ms,
                        my_x, my_y, target_dest_x, target_dest_y, "opp_into_self")
                    continue
                # Case B: we're also moving — check our destination vs their destination
                if my_moving and self._punch_lateral_xy(my_x, my_y, target_dest_x, target_dest_y):
                    both_step = max(step_ms, my_step_ms)
                    self._prequeue_schedule_fire(scene_id, both_step, half_rtt, now_ms,
                        my_x, my_y, target_dest_x, target_dest_y, "both_moving")

    def _prequeue_schedule_fire(self, target_id: str, step_ms: int, half_rtt: int,
                                 now_ms: int, sx: int, sy: int, tx: int, ty: int, reason: str) -> None:
        """Schedule a precisely-timed punch to arrive at the server when the step completes."""
        dedup_key = f"{target_id}:{tx},{ty}"
        # Don't double-fire the same contact opportunity
        if dedup_key == self.prequeue_pending_key and now_ms < self.prequeue_pending_until_ms:
            return
        # Cooldown: don't fire more than once per 400ms (server punch cooldown)
        if now_ms - self.prequeue_last_fire_ms < 400:
            return

        # Calculate when to fire:
        # Server started step at: now - half_rtt (packet was in transit)
        # Step completes at server: now - half_rtt + step_ms
        # Our punch takes half_rtt to reach server
        # Fire at: now - half_rtt + step_ms - half_rtt = now + step_ms - 2*half_rtt
        # But fire slightly early (10ms) so punch is waiting when step completes
        fire_delay_ms = max(0, step_ms - 2 * half_rtt - 10)

        # Mark as pending
        self.prequeue_pending_key = dedup_key
        self.prequeue_pending_until_ms = now_ms + fire_delay_ms + 500  # dedup window

        if fire_delay_ms <= 5:
            # Fire immediately
            self._prequeue_fire_now(target_id, now_ms, sx, sy, tx, ty, reason, fire_delay_ms)
        else:
            # Schedule delayed fire
            threading.Timer(
                fire_delay_ms / 1000.0,
                self._prequeue_fire_now,
                args=(target_id, now_ms, sx, sy, tx, ty, reason, fire_delay_ms),
            ).start()

        self.log(
            f"PREQUEUE scheduled: target={target_id} delay={fire_delay_ms}ms "
            f"step={step_ms}ms rtt={half_rtt*2}ms reason={reason} "
            f"self=({sx},{sy}) target=({tx},{ty})",
            console=True,
        )

    def _prequeue_fire_now(self, target_id: str, scheduled_at_ms: int,
                            sx: int, sy: int, tx: int, ty: int,
                            reason: str, planned_delay_ms: int) -> None:
        """Actually send the pre-queued punch RIGHT NOW."""
        now_ms = int(time.time() * 1000)
        # Gate checks
        if not self.crypto_active or self.server_encrypt is None:
            return
        if not self.config.prequeue_punch:
            return
        if now_ms < self.proxy_contact_inhibit_until_ms:
            return
        if self._proxy_auto_punch_block(now_ms, include_recent_busy=True) is not None:
            return

        copies = self.prequeue_copies
        frame = build_punch_frame(target_id)
        payload = bytes(frame) * copies  # 2 copies back-to-back

        try:
            with self.upstream_lock:
                encrypted = self.server_encrypt.crypt(payload)
                self.remote_sock.sendall(encrypted)
        except (ConnectionError, OSError) as exc:
            self.last_error = f"PREQUEUE fire failed: {exc}"
            return

        self.prequeue_fires += 1
        self.prequeue_last_fire_ms = now_ms
        self.prequeue_last_target = target_id
        self.punches_injected += copies
        self.proxy_contact_inhibit_until_ms = max(
            self.proxy_contact_inhibit_until_ms,
            now_ms + PROXY_AUTO_PUNCH_POST_SEND_INHIBIT_MS,
        )
        self.proxy_contact_burst_id += 1

        for copy_idx in range(copies):
            self._record_punch_send(
                target_id=target_id,
                source="prequeue_v6",
                copy_index=copy_idx + 1,
                copy_total=copies,
                move_attached=False,
            )

        actual_delay = now_ms - scheduled_at_ms
        self.registry.add_event(
            {
                "type": "PREQUEUE_FIRE",
                "target_id": target_id,
                "reason": reason,
                "copies": copies,
                "planned_delay_ms": planned_delay_ms,
                "actual_delay_ms": actual_delay,
                "self_tile": [sx, sy],
                "target_tile": [tx, ty],
                "half_rtt_ms": self._get_half_rtt_ms(),
                "ts_ms": now_ms,
            }
        )

    @staticmethod
    def _proxy_release_point_at(path: Dict[str, object], at_ms: int) -> Tuple[float, float]:
        start_ms = int(path.get("start_ms") or at_ms)
        end_ms = int(path.get("end_ms") or start_ms)
        from_x = float(path.get("from_x") or 0.0)
        from_y = float(path.get("from_y") or 0.0)
        to_x = float(path.get("to_x") or from_x)
        to_y = float(path.get("to_y") or from_y)
        if at_ms <= start_ms or end_ms <= start_ms:
            return from_x, from_y
        if at_ms >= end_ms:
            return to_x, to_y
        ratio = float(at_ms - start_ms) / float(end_ms - start_ms)
        return from_x + (to_x - from_x) * ratio, from_y + (to_y - from_y) * ratio

    @staticmethod
    def _proxy_contact_entry_age_ms(entry: Optional[Dict[str, object]], now_ms: int) -> int:
        if not entry:
            return 999999
        stamps: List[int] = []
        for key in ("last_move_ts_ms", "last_pose_ts_ms", "last_board_pose_ts_ms", "last_hub_pose_ts_ms", "last_scene_pose_ts_ms"):
            value = entry.get(key)
            if isinstance(value, int) and value > 0:
                stamps.append(int(value))
        if not stamps:
            return 999999
        return max(0, now_ms - max(stamps))

    def _proxy_contact_self_confirmed(self, entry: Optional[Dict[str, object]] = None) -> bool:
        if self.my_scene_source in ("account", "opcode134", "board", "hub_swf"):
            return True
        if entry and entry.get("board_is_self") is True:
            return True
        if entry and self.my_player_id and str(entry.get("account_id") or "") == str(self.my_player_id):
            return True
        return False

    def _proxy_contact_static_self_pose_allowed(self, entry: Optional[Dict[str, object]]) -> bool:
        if not self._proxy_contact_self_confirmed(entry):
            return False
        if entry is None:
            return False
        return parse_int_field(entry.get("x")) is not None and parse_int_field(entry.get("y")) is not None

    @staticmethod
    def _proxy_contact_quantize_xy(value: object) -> int:
        try:
            return int(round(float(value)))
        except (TypeError, ValueError):
            return 0

    def _proxy_release_first_contact(
        self,
        self_path: Dict[str, object],
        target_path: Dict[str, object],
        axis_mode: str,
        now_ms: int,
        horizon_ms: int = PROXY_RELEASE_PREDICT_HORIZON_MS,
    ) -> Optional[Dict[str, object]]:
        best_near: Optional[Dict[str, object]] = None
        end_ms = now_ms + max(0, int(horizon_ms))
        sx_now, sy_now = self._proxy_release_point_at(self_path, now_ms)
        tx_now, ty_now = self._proxy_release_point_at(target_path, now_ms)
        self_remaining_ms = max(0, int(int(self_path.get("end_ms") or now_ms) - now_ms))
        target_remaining_ms = max(0, int(int(target_path.get("end_ms") or now_ms) - now_ms))
        precise = self._proxy_precise_precontact_hit(
            (
                float(sx_now),
                float(sy_now),
                float(self_path.get("to_x") if self_path.get("to_x") is not None else sx_now),
                float(self_path.get("to_y") if self_path.get("to_y") is not None else sy_now),
                self_remaining_ms,
            ),
            (
                float(tx_now),
                float(ty_now),
                float(target_path.get("to_x") if target_path.get("to_x") is not None else tx_now),
                float(target_path.get("to_y") if target_path.get("to_y") is not None else ty_now),
                target_remaining_ms,
            ),
            axis_mode,
            horizon_ms,
        )
        if precise is not None:
            return precise
        # --- Contact V5 Fix 4: check integer tiles FIRST (the server validates at integer positions) ---
        sx_final = self._proxy_contact_quantize_xy(self_path.get("to_x"))
        sy_final = self._proxy_contact_quantize_xy(self_path.get("to_y"))
        tx_final = self._proxy_contact_quantize_xy(target_path.get("to_x"))
        ty_final = self._proxy_contact_quantize_xy(target_path.get("to_y"))
        # Check if final integer tiles are already in diagonal contact (server will validate this)
        if self._punch_lateral_xy(sx_final, sy_final, tx_final, ty_final):
            tile_eta = max(0, max(
                int(int(self_path.get("end_ms") or now_ms) - now_ms),
                int(int(target_path.get("end_ms") or now_ms) - now_ms),
            ))
            half_rtt = self._get_half_rtt_ms()
            tile_fire_delay = max(0, tile_eta - half_rtt)  # Fix 6: compensate for punch travel time
            tile_axis = self._strict_punch_axis_label(sx_final, sy_final, tx_final, ty_final)
            if tile_fire_delay <= int(horizon_ms):
                return {
                    "in_ms": tile_eta,
                    "contact_eta_ms": tile_eta,
                    "fire_delay_ms": tile_fire_delay,
                    "lead_ms": tile_eta - tile_fire_delay,
                    "axis": tile_axis or "MAIN_SIDE",
                    "kind": "ring_tile_exact",
                    "dx": float(tx_final - sx_final),
                    "dy": float(ty_final - sy_final),
                    "self_xy": [float(sx_final), float(sy_final)],
                    "target_xy": [float(tx_final), float(ty_final)],
                    "self_tile": [sx_final, sy_final],
                    "target_tile": [tx_final, ty_final],
                    "rtt_compensated": True,
                    "half_rtt_ms": half_rtt,
                }
        offsets = self._adaptive_grid_offsets_ms(horizon_ms)
        for offset_ms in offsets:
            at_ms = min(end_ms, now_ms + int(offset_ms))
            sx, sy = self._proxy_release_point_at(self_path, at_ms)
            tx, ty = self._proxy_release_point_at(target_path, at_ms)
            dx = tx - sx
            dy = ty - sy
            axis = self._contact_axis_label_float(sx, sy, tx, ty)
            tile_sx = int(round(sx))
            tile_sy = int(round(sy))
            tile_tx = int(round(tx))
            tile_ty = int(round(ty))
            tile_axis = self._strict_punch_axis_label(tile_sx, tile_sy, tile_tx, tile_ty)
            contact = self._ring_lateral_contact(dx, dy)
            near = abs(dx) <= 2.25 and abs(dy) <= 2.25
            if near and best_near is None:
                best_near = {
                    "in_ms": at_ms - now_ms,
                    "axis": axis,
                    "tile_axis": tile_axis,
                    "dx": round(dx, 3),
                    "dy": round(dy, 3),
                    "ring": contact,
                }
            if contact and self._proxy_contact_axis_allowed(str(contact.get("axis") or axis), axis_mode) and int(contact.get("priority") or 99) <= 1:
                contact_eta = int(at_ms - now_ms)
                half_rtt = self._get_half_rtt_ms()
                fire_delay = max(0, contact_eta - PRECONTACT_LEAD_MS - half_rtt)  # Contact V5 Fix 6: RTT compensation
                return {
                    "in_ms": contact_eta,
                    "contact_eta_ms": contact_eta,
                    "fire_delay_ms": fire_delay,
                    "lead_ms": contact_eta - fire_delay,
                    "axis": str(contact.get("axis") or tile_axis or axis),
                    "kind": f"ring_{str(contact.get('kind') or 'predict').lower()}",
                    "ring": contact,
                    "dx": round(dx, 3),
                    "dy": round(dy, 3),
                    "self_xy": [round(sx, 3), round(sy, 3)],
                    "target_xy": [round(tx, 3), round(ty, 3)],
                    "self_tile": [tile_sx, tile_sy],
                    "target_tile": [tile_tx, tile_ty],
                    "near": best_near,
                    "rtt_compensated": True,
                    "half_rtt_ms": half_rtt,
                }
        return None

    def _proxy_pick_contact_targets(
        self,
        now_ms: int,
        horizon_ms: int,
        max_fire_in_ms: Optional[int],
        max_targets: int = PROXY_CONTACT_MAX_TARGETS,
    ) -> Tuple[List[Dict[str, object]], Dict[str, object]]:
        if not self.my_scene_id:
            return [], {"skip": "no_self"}
        my_scene_id = str(self.my_scene_id)
        self_entry = self.scene_roster.get(my_scene_id)
        self_path = self._proxy_release_actor_path(self_entry, now_ms)
        if self_path is None:
            return [], {"skip": "no_self_path", "self": my_scene_id}
        if not self._proxy_contact_self_confirmed(self_entry):
            return [], {"skip": "self_unconfirmed", "self": my_scene_id, "source": self.my_scene_source or "none"}
        self_age_ms = self._proxy_contact_entry_age_ms(self_entry, now_ms)
        static_self_pose = self._proxy_contact_static_self_pose_allowed(self_entry)
        if self_age_ms > PROXY_CONTACT_SELF_STALE_MS and not static_self_pose:
            return [], {"skip": "stale_self", "self": my_scene_id, "age_ms": self_age_ms, "source": self.my_scene_source or "none"}
        axis_mode = sanitize_proxy_contact_axis(self.config.proxy_contact_axis)
        candidates: List[Dict[str, object]] = []
        near_skips: List[Dict[str, object]] = []
        stale_skips: List[Dict[str, object]] = []
        for scene_id, entry in list(self.scene_roster.items()):
            target_id = str(scene_id)
            if target_id == my_scene_id or not self.is_probable_ring_scene_id(target_id):
                continue
            if not self.is_probable_ring_scene_id(target_id):
                continue
            target_age_ms = self._proxy_contact_entry_age_ms(entry, now_ms)
            if target_age_ms > PROXY_CONTACT_TARGET_STALE_MS:
                if len(stale_skips) < 8:
                    stale_skips.append(
                        {
                            "id": target_id,
                            "age_ms": target_age_ms,
                            "xy": [entry.get("x"), entry.get("y")],
                            "state": entry.get("state_code"),
                        }
                    )
                continue
            target_path = self._proxy_release_actor_path(entry, now_ms)
            if target_path is None:
                continue
            contact = self._proxy_release_first_contact(self_path, target_path, axis_mode, now_ms, horizon_ms)
            # --- Contact V5 Fix 5: try predicted next step if no contact with current path ---
            if contact is None:
                predicted_target_path = self._predict_next_step_path(target_id, target_path, now_ms)
                if predicted_target_path is not None:
                    # Also try self prediction
                    predicted_self_path = self._predict_next_step_path(my_scene_id, self_path, now_ms)
                    contact = self._proxy_release_first_contact(
                        predicted_self_path or self_path, predicted_target_path, axis_mode, now_ms, horizon_ms
                    )
                    if contact:
                        contact["predicted"] = True
            tx, ty = self._proxy_release_point_at(target_path, now_ms)
            sx, sy = self._proxy_release_point_at(self_path, now_ms)
            dx = tx - sx
            dy = ty - sy
            current_axis = self._strict_punch_axis_label(int(round(sx)), int(round(sy)), int(round(tx)), int(round(ty)))
            current_allowed = bool(current_axis)
            if contact is None:
                if abs(dx) <= 2.0 and abs(dy) <= 2.0 and len(near_skips) < 8:
                    near_skips.append(
                        {
                            "id": target_id,
                            "axis": current_axis,
                            "dx": round(dx, 3),
                            "dy": round(dy, 3),
                            "state": entry.get("state_code"),
                        }
                )
                continue
            contact_eta = self._contact_eta_ms_from_candidate({"contact": contact})
            fire_delay = self._fire_delay_ms_from_candidate({"contact": contact})
            contact["contact_eta_ms"] = contact_eta
            contact["contact_in_ms"] = contact_eta
            contact["fire_delay_ms"] = fire_delay
            if max_fire_in_ms is not None and fire_delay > int(max_fire_in_ms):
                if len(near_skips) < 8:
                    near_skips.append(
                        {
                            "id": target_id,
                            "axis": contact.get("axis"),
                            "contact_eta_ms": contact_eta,
                            "fire_delay_ms": fire_delay,
                            "dx": round(float(contact.get("dx") or dx), 3),
                            "dy": round(float(contact.get("dy") or dy), 3),
                            "state": entry.get("state_code"),
                            "skip": "future_contact",
                        }
                    )
                continue
            state_code = self._proxy_release_state_int(entry.get("state_code"))
            if state_code in (2, 3, 7, 8, 9, 10, 14):
                state_rank = 0
            elif state_code is None:
                state_rank = 1
            else:
                state_rank = 2
            seen_age = target_age_ms
            contact_dx = float(contact.get("dx") if contact.get("dx") is not None else dx)
            contact_dy = float(contact.get("dy") if contact.get("dy") is not None else dy)
            current_distance_score = int(round((abs(dx) + abs(dy)) * 100))
            contact_distance_score = int(round((abs(contact_dx) + abs(contact_dy)) * 100))
            if current_allowed:
                phase_rank = 0
            elif fire_delay <= 16:
                phase_rank = 1
            elif fire_delay <= 42:
                phase_rank = 2
            elif fire_delay <= 88:
                phase_rank = 3
            else:
                phase_rank = 4
            distance_score = current_distance_score if current_allowed else contact_distance_score
            moving_rank = 0 if bool(self_path.get("moving")) or bool(target_path.get("moving")) else 1
            try:
                id_rank = int(target_id)
            except ValueError:
                id_rank = 9999
            score = (
                phase_rank,
                distance_score,
                fire_delay,
                contact_eta,
                min(999, max(0, seen_age // 50)),
                state_rank,
                moving_rank,
                id_rank,
            )
            candidates.append(
                {
                    "id": target_id,
                    "score": list(score),
                    "contact": contact,
                    "contact_eta_ms": contact_eta,
                    "fire_delay_ms": fire_delay,
                    "state": state_code,
                    "moving": bool(target_path.get("moving")),
                    "current_axis": current_axis,
                    "current_dx": round(dx, 3),
                    "current_dy": round(dy, 3),
                    "current_allowed": current_allowed,
                    "phase_rank": phase_rank,
                    "path": [target_path.get("from_x"), target_path.get("from_y"), target_path.get("to_x"), target_path.get("to_y")],
                    "seen_age_ms": seen_age if seen_age < 999999 else None,
                }
            )
        candidates.sort(key=lambda item: tuple(item.get("score") or [999999]))
        debug = {
            "axis_mode": axis_mode,
            "self": my_scene_id,
            "self_source": self.my_scene_source or "none",
            "self_static_pose": static_self_pose,
            "self_age_ms": self_age_ms if self_age_ms < 999999 else None,
            "self_path": [self_path.get("from_x"), self_path.get("from_y"), self_path.get("to_x"), self_path.get("to_y")],
            "horizon_ms": int(horizon_ms),
            "max_fire_in_ms": max_fire_in_ms,
            "movement": self.movement_debug_snapshot(),
            "candidates": candidates[:6],
            "near_skips": near_skips,
            "stale_skips": stale_skips,
        }
        return candidates[:max(1, min(PROXY_CONTACT_MAX_TARGETS, int(max_targets)))], debug

    def _proxy_release_pick_targets(self, now_ms: int) -> Tuple[List[Dict[str, object]], Dict[str, object]]:
        return self._proxy_pick_contact_targets(now_ms, self._adaptive_release_horizon_ms(), self._adaptive_release_fire_ahead_ms(), self._proxy_contact_max_targets())

    def _proxy_release_counter_batch(self, burst_id: int, release_at_ms: int, delay_ms: int, ladder_index: int) -> None:
        now_ms = int(time.time() * 1000)
        if burst_id != self.proxy_release_counter_burst_id:
            return
        release_enabled = self.config.proxy_contact_counter or self.config.packet_brain
        if not release_enabled or not self.crypto_active or self.server_encrypt is None:
            self.proxy_release_counter_skips += 1
            self.proxy_release_counter_last_debug = {
                "skip": "release_gate",
                "enabled": release_enabled,
                "crypto": self.crypto_active,
                "encrypt": self.server_encrypt is not None,
                "delay_ms": delay_ms,
            }
            return
        if now_ms < self.proxy_contact_inhibit_until_ms:
            self.proxy_release_counter_skips += 1
            self.proxy_release_counter_last_debug = {
                "skip": "post_resolve_inhibit",
                "inhibit_ms": self.proxy_contact_inhibit_until_ms - now_ms,
                "delay_ms": delay_ms,
                "ladder_index": ladder_index,
            }
            return
        if now_ms - release_at_ms > 90:
            self.proxy_release_counter_skips += 1
            self.proxy_release_counter_last_debug = {
                "skip": "timer_late",
                "late_ms": now_ms - release_at_ms,
                "delay_ms": delay_ms,
                "ladder_index": ladder_index,
            }
            return
        try:
            selected_candidates, debug = self._proxy_release_pick_targets(now_ms)
        except Exception as exc:
            self.proxy_release_counter_skips += 1
            self.proxy_release_counter_last_debug = {"skip": "release_pick_error", "error": str(exc), "delay_ms": delay_ms}
            return
        selected_candidates = self._compatible_contact_candidates(selected_candidates, 1)
        selected_targets = [str(item.get("id")) for item in selected_candidates if normalize_target_id(item.get("id")) is not None]
        if not selected_targets:
            self.proxy_release_counter_skips += 1
            self.proxy_release_counter_last_debug = {"skip": "no_release_target", "delay_ms": delay_ms, **debug}
            return
        try:
            frames_by_target = {target_id: build_punch_frame(target_id) for target_id in selected_targets}
        except ValueError:
            self.proxy_release_counter_skips += 1
            self.proxy_release_counter_last_debug = {"skip": "invalid_release_target", "targets": selected_targets, **debug}
            return
        copies = sanitize_proxy_contact_copies(self.config.packet_brain_copies if self.config.packet_brain else self.config.proxy_contact_copies)
        source_base = "packet_brain_release" if self.config.packet_brain else "proxy_release"
        ok = self._send_proxy_contact_batch(
            selected_targets,
            frames_by_target,
            copies,
            delay_ms,
            ladder_index,
            len(PROXY_RELEASE_SCAN_OFFSETS_MS),
            source_base,
        )
        if not ok:
            self.proxy_release_counter_skips += 1
            self.proxy_release_counter_last_debug = {"skip": "send_failed", "targets": selected_targets, **debug}
            return
        self.proxy_release_counter_burst_id += 1
        self.proxy_release_counter_fires += 1
        self.proxy_release_counter_last_fire_at_ms = now_ms
        best = selected_candidates[0]
        contact = best.get("contact") or {}
        self.proxy_release_counter_last_reason = f"target={best.get('id')} in={contact.get('in_ms')}ms axis={contact.get('axis')} delay={delay_ms} fanout={len(selected_targets)}"
        self.proxy_release_counter_last_debug = {
            "targets": selected_targets,
            "delay_ms": delay_ms,
            "ladder_index": ladder_index,
            **debug,
        }
        self.registry.add_event(
            {
                "type": "PROXY_RELEASE_COUNTER_FIRE",
                "session_id": self.session_id,
                "targets": selected_targets,
                "delay_ms": delay_ms,
                "reason": self.proxy_release_counter_last_reason,
                "candidates": selected_candidates[:6],
            }
        )

    def _proxy_release_counter_arm(
        self,
        now_ms: int,
        expected_ready_ms: int,
        schedule_offsets_ms: Tuple[int, ...],
        state_label: str,
        source: str,
        extra: Optional[Dict[str, object]] = None,
    ) -> None:
        release_enabled = self.config.proxy_contact_counter or self.config.packet_brain
        if not release_enabled or not self.crypto_active or self.server_encrypt is None:
            self.proxy_release_counter_last_debug = {
                "skip": "release_arm_gate",
                "enabled": release_enabled,
                "crypto": self.crypto_active,
                "encrypt": self.server_encrypt is not None,
                "source": source,
                "state": state_label,
            }
            return
        arm_key = f"{source}:{state_label}:{int(expected_ready_ms / 35)}"
        if now_ms - self.proxy_release_counter_last_arm_at_ms < 90 and arm_key == self.proxy_release_counter_last_arm_key:
            return
        self.proxy_release_counter_burst_id += 1
        burst_id = self.proxy_release_counter_burst_id
        self.proxy_release_counter_last_state = state_label
        self.proxy_release_counter_last_state_at_ms = now_ms
        self.proxy_release_counter_last_arm_at_ms = now_ms
        self.proxy_release_counter_last_arm_key = arm_key
        delays = [max(0, int(expected_ready_ms - now_ms + int(offset))) for offset in schedule_offsets_ms]
        self.proxy_release_counter_last_debug = {
            "arm": source,
            "state": state_label,
            "expected_ready_in_ms": max(0, expected_ready_ms - now_ms),
            "delays": delays,
            "offsets": list(schedule_offsets_ms),
            "self_scene_id": self.my_scene_id or "?",
            **(extra or {}),
        }
        for index, delay_ms in enumerate(delays, start=1):
            if delay_ms <= 0:
                self._proxy_release_counter_batch(burst_id, expected_ready_ms, 0, index)
            else:
                timer = threading.Timer(delay_ms / 1000.0, self._proxy_release_counter_batch, args=(burst_id, expected_ready_ms, int(delay_ms), index))
                timer.daemon = True
                timer.start()
        self.registry.add_event(
            {
                "type": "PROXY_RELEASE_COUNTER_ARM",
                "session_id": self.session_id,
                "state": state_label,
                "source": source,
                "expected_ready_in_ms": max(0, expected_ready_ms - now_ms),
                "delays": delays,
                "offsets": list(schedule_offsets_ms),
                "self_scene_id": self.my_scene_id or "?",
                **(extra or {}),
            }
        )

    def _proxy_release_counter_start(
        self,
        old_state: Optional[int],
        new_state: Optional[int],
        now_ms: int,
        source: str = "state146",
        old_busy: Optional[bool] = None,
        new_busy: Optional[bool] = None,
        new_ready: Optional[bool] = None,
    ) -> None:
        was_busy = bool(old_busy) or (old_state in PROXY_RELEASE_BUSY_STATES if old_state is not None else False)
        is_ready = bool(new_ready) or (new_busy is False) or (new_state in PROXY_RELEASE_READY_STATES if new_state is not None else False)
        if not was_busy or not is_ready:
            return
        if now_ms - self.proxy_release_counter_last_fire_at_ms < 28:
            return
        self._proxy_release_counter_arm(
            now_ms,
            now_ms,
            PROXY_RELEASE_SCAN_OFFSETS_MS,
            f"{old_state}>{new_state}",
            source,
            {"old_busy": bool(old_busy), "new_busy": new_busy, "new_ready": bool(new_ready)},
        )

    def _proxy_release_counter_prearm(
        self,
        now_ms: int,
        ready_delay_ms: int,
        source: str,
        state_label: str,
        combat_state: object,
    ) -> None:
        if ready_delay_ms < 0 or ready_delay_ms > PROXY_RELEASE_PREARM_MAX_MS:
            return
        if now_ms - self.proxy_release_counter_last_arm_at_ms < 58:
            return
        expected_ready_ms = now_ms + int(ready_delay_ms)
        self._proxy_release_counter_arm(
            now_ms,
            expected_ready_ms,
            PROXY_RELEASE_PREARM_OFFSETS_MS,
            f"prearm:{state_label}",
            source,
            {
                "ready_delay_ms": int(ready_delay_ms),
                "combat": combat_state if isinstance(combat_state, dict) else {},
            },
        )

    def _start_proxy_contact_scanner(self) -> None:
        if self.proxy_contact_scan_thread is not None and self.proxy_contact_scan_thread.is_alive():
            return
        self.proxy_contact_scan_stop = False
        self.proxy_contact_scan_thread = threading.Thread(target=self._proxy_contact_scan_loop, daemon=True)
        self.proxy_contact_scan_thread.start()

    def _stop_proxy_contact_scanner(self) -> None:
        self.proxy_contact_scan_stop = True

    def _proxy_contact_scan_loop(self) -> None:
        while not self.proxy_contact_scan_stop and self.crypto_active:
            try:
                if self.config.proxy_contact_counter:
                    self._proxy_contact_scan_tick(int(time.time() * 1000))
                if self.config.packet_brain:
                    now_ms = int(time.time() * 1000)
                    if now_ms - self.packet_brain_last_quiet_scan_ms >= PACKET_BRAIN_SCAN_INTERVAL_MS:
                        self.packet_brain_last_quiet_scan_ms = now_ms
                        self._packet_brain_fire_from_roster(
                            now_ms,
                            "quiet_scan",
                            PACKET_BRAIN_QUIET_OFFSETS_MS,
                            self._adaptive_contact_horizon_ms(),
                            min(self._adaptive_contact_fire_ahead_ms(), 160),
                        )
                if self.config.proxy_contact_counter or self.config.packet_brain:
                    time.sleep(PROXY_CONTACT_SCAN_INTERVAL_MS / 1000.0)
                else:
                    time.sleep(0.025)
            except (ConnectionError, OSError):
                break
            except Exception as exc:
                self.proxy_contact_scan_skips += 1
                self.proxy_contact_scan_last_debug = {"skip": "scan_error", "error": str(exc)}
                self.log(f"PROXY_CONTACT_SCAN error {exc}", console=self.config.verbose)
                time.sleep(0.03)

    def _proxy_contact_scan_send_selected(
        self,
        now_ms: int,
        best: Dict[str, object],
        selected_candidates: List[Dict[str, object]],
        debug: Dict[str, object],
        key: str,
        fire_in_ms: int,
        hard_immediate: bool,
        rearm: str,
    ) -> bool:
        best_target_id = normalize_target_id(best.get("id"))
        if best_target_id is None:
            self.proxy_contact_scan_skips += 1
            self.proxy_contact_scan_last_debug = {"skip": "invalid_scan_target", "candidate": best, **debug}
            return False
        contact = best.get("contact") or {}
        contact_eta = self._contact_eta_ms_from_candidate(best)
        fire_delay = self._fire_delay_ms_from_candidate(best)
        axis = str(contact.get("axis") or "")
        selected_candidates = self._compatible_contact_candidates(selected_candidates, 1)
        selected_targets = []
        for item in selected_candidates:
            item_id = normalize_target_id(item.get("id"))
            if item_id is not None and item_id not in selected_targets:
                selected_targets.append(item_id)
        if not selected_targets:
            selected_targets = [best_target_id]
        try:
            frames_by_target = {target_id: build_punch_frame(target_id) for target_id in selected_targets}
        except ValueError:
            self.proxy_contact_scan_skips += 1
            self.proxy_contact_scan_last_debug = {"skip": "invalid_scan_frame", "targets": selected_targets}
            return False
        copies = sanitize_proxy_contact_copies(self.config.proxy_contact_copies)
        ladder_ms = sanitize_proxy_contact_ladder_ms(self.config.proxy_contact_ladder_ms)
        ladder_steps = sanitize_proxy_contact_ladder_steps(self.config.proxy_contact_ladder_steps)
        scheduled_batches = self._queue_proxy_contact_ladder(selected_targets, frames_by_target, copies, ladder_ms, ladder_steps, "proxy_scan")
        if scheduled_batches <= 0:
            self.proxy_contact_scan_skips += 1
            self.proxy_contact_scan_last_debug = {"skip": "scan_send_failed", "targets": selected_targets, **debug}
            return False
        self.proxy_contact_scan_fires += 1
        self.proxy_contact_scan_last_fire_at_ms = now_ms
        self.proxy_contact_scan_last_key = key
        self.proxy_contact_scan_last_key_at[key] = now_ms
        self.proxy_contact_scan_last_contact_in_by_key[key] = fire_delay
        self.proxy_contact_scan_scheduled_at_by_key.pop(key, None)
        self.proxy_contact_scan_burst_until_ms = now_ms + max(
            PROXY_CONTACT_SCAN_BURST_COOLDOWN_MS,
            ladder_ms + 32,
        )
        if len(self.proxy_contact_scan_last_key_at) > 256:
            cutoff = now_ms - PROXY_CONTACT_SCAN_KEY_TTL_MS
            self.proxy_contact_scan_last_key_at = {
                item_key: item_at
                for item_key, item_at in self.proxy_contact_scan_last_key_at.items()
                if item_at >= cutoff
            }
            self.proxy_contact_scan_last_contact_in_by_key = {
                item_key: self.proxy_contact_scan_last_contact_in_by_key.get(item_key, 999999)
                for item_key, item_at in self.proxy_contact_scan_last_key_at.items()
            }
        fanout = len(selected_targets)
        self.proxy_contact_scan_last_reason = f"target={best_target_id} fire={fire_delay}ms contact={contact_eta}ms axis={axis} fanout={fanout} ladder={ladder_ms}x{scheduled_batches}"
        self.proxy_contact_scan_last_debug = {
            "target": best_target_id,
            "targets": selected_targets,
            "fanout": fanout,
            "reason": self.proxy_contact_scan_last_reason,
            "copies": copies,
            "ladder_ms": ladder_ms,
            "ladder_steps": scheduled_batches,
            "burst_cooldown_until_ms": self.proxy_contact_scan_burst_until_ms,
            "key": key,
            "hard_immediate": hard_immediate,
            "rearm": rearm,
            "fire_in_ms": fire_in_ms,
            "fire_delay_ms": fire_delay,
            "contact_eta_ms": contact_eta,
            "movement": self.movement_debug_snapshot(),
            "candidate": best,
            **debug,
        }
        self.registry.add_event(
            {
                "type": "PROXY_CONTACT_SCAN_FIRE",
                "session_id": self.session_id,
                "target_id": best_target_id,
                "targets": selected_targets,
                "reason": self.proxy_contact_scan_last_reason,
                "copies": copies,
                "ladder_ms": ladder_ms,
                "ladder_steps": scheduled_batches,
                "candidate": best,
                "candidates": selected_candidates[:4],
                "rearm": rearm,
            }
        )
        return True

    def _proxy_contact_schedule_scan_fire(
        self,
        now_ms: int,
        key: str,
        target_id: str,
        contact_in_ms: int,
        best: Dict[str, object],
        debug: Dict[str, object],
        source: str,
    ) -> bool:
        contact = best.get("contact") if isinstance(best, dict) else None
        fire_delay_value = parse_int_field(contact.get("fire_delay_ms") if isinstance(contact, dict) else None)
        delay_ms = max(0, int(fire_delay_value)) if fire_delay_value is not None else self._proxy_contact_schedule_delay_ms(contact_in_ms)
        if delay_ms <= 0:
            return False
        due_ms = now_ms + delay_ms
        existing_due = int(self.proxy_contact_scan_scheduled_at_by_key.get(key) or 0)
        if existing_due and existing_due >= now_ms and abs(existing_due - due_ms) <= PROXY_CONTACT_SCHEDULE_REUSE_MS:
            self.proxy_contact_scan_skips += 1
            self.proxy_contact_scan_last_debug = {
                "skip": "scan_already_scheduled",
                "target": target_id,
                "contact_in_ms": contact_in_ms,
                "due_in_ms": existing_due - now_ms,
                "key": key,
                "candidate": best,
            }
            return True
        try:
            frames_by_target = {target_id: build_punch_frame(target_id)}
        except ValueError:
            self.proxy_contact_scan_skips += 1
            self.proxy_contact_scan_last_debug = {"skip": "schedule_frame_error", "target": target_id, "source": source, "candidate": best}
            return False
        if len(self.proxy_contact_scan_scheduled_at_by_key) > 256:
            self.proxy_contact_scan_scheduled_at_by_key = {
                item_key: item_due
                for item_key, item_due in self.proxy_contact_scan_scheduled_at_by_key.items()
                if item_due >= now_ms - 120
            }
        self.proxy_contact_scan_scheduled_at_by_key[key] = due_ms
        self.proxy_contact_scan_last_key_at[key] = now_ms
        self.proxy_contact_scan_last_contact_in_by_key[key] = delay_ms
        copies = sanitize_proxy_contact_copies(self.config.proxy_contact_copies)
        ladder_ms = sanitize_proxy_contact_ladder_ms(self.config.proxy_contact_ladder_ms)
        ladder_steps = sanitize_proxy_contact_ladder_steps(self.config.proxy_contact_ladder_steps)
        burst_id = self.proxy_contact_burst_id
        scheduled_batches = 0
        total_batches = ladder_steps if ladder_ms > 0 and ladder_steps > 1 else 1
        for idx in range(total_batches):
            extra_ms = int(round(float(idx) * float(ladder_ms) / float(max(1, total_batches - 1)))) if total_batches > 1 else 0
            batch_delay_ms = delay_ms + extra_ms
            timer = threading.Timer(
                batch_delay_ms / 1000.0,
                self._send_proxy_contact_scheduled_batch,
                args=(burst_id, target_id, frames_by_target, copies, batch_delay_ms, idx + 1, total_batches, f"proxy_{source}_precontact", key, now_ms + batch_delay_ms),
            )
            timer.daemon = True
            timer.start()
            scheduled_batches += 1
        self.proxy_contact_scan_burst_until_ms = max(
            self.proxy_contact_scan_burst_until_ms,
            due_ms + ladder_ms + PROXY_CONTACT_SCAN_BURST_COOLDOWN_MS,
        )
        if source == "counter":
            self.proxy_contact_counter_fires += 1
            self.proxy_contact_counter_last_fire_at_ms = now_ms
            self.proxy_contact_counter_last_target = target_id
            self.proxy_contact_counter_last_reason = f"precontact target={target_id} fire={delay_ms}ms contact={contact_in_ms}ms ladder={ladder_ms}x{scheduled_batches}"
        else:
            self.proxy_contact_scan_fires += 1
            self.proxy_contact_scan_last_fire_at_ms = now_ms
            self.proxy_contact_scan_last_key = key
            self.proxy_contact_scan_last_reason = f"precontact target={target_id} fire={delay_ms}ms contact={contact_in_ms}ms ladder={ladder_ms}x{scheduled_batches}"
        self.proxy_contact_scan_last_debug = {
            "schedule": source,
            "target": target_id,
            "contact_in_ms": contact_in_ms,
            "delay_ms": delay_ms,
            "direct": True,
            "copies": copies,
            "ladder_ms": ladder_ms,
            "ladder_steps": scheduled_batches,
            "prefire_lead_ms": self._proxy_contact_prefire_lead_ms(),
            "key": key,
            "movement": self.movement_debug_snapshot(),
            "candidate": best,
            **debug,
        }
        self.registry.add_event(
            {
                "type": "PROXY_CONTACT_SCAN_SCHEDULE",
                "session_id": self.session_id,
                "target_id": target_id,
                "contact_in_ms": contact_in_ms,
                "delay_ms": delay_ms,
                "source": source,
                "direct": True,
                "copies": copies,
                "ladder_ms": ladder_ms,
                "ladder_steps": scheduled_batches,
                "candidate": best,
            }
        )
        return True

    def _proxy_contact_scan_delayed_fire(self, key: str, target_id: str, due_ms: int, source: str) -> None:
        now_ms = int(time.time() * 1000)
        if self.proxy_contact_scan_scheduled_at_by_key.get(key) != due_ms:
            return
        self.proxy_contact_scan_scheduled_at_by_key.pop(key, None)
        if now_ms < self.proxy_contact_inhibit_until_ms:
            self.proxy_contact_scan_skips += 1
            self.proxy_contact_scan_last_debug = {
                "skip": "post_resolve_inhibit",
                "target": target_id,
                "source": source,
                "inhibit_ms": self.proxy_contact_inhibit_until_ms - now_ms,
            }
            return
        if not self.config.proxy_contact_counter or not self.crypto_active or self.server_encrypt is None:
            self.proxy_contact_scan_skips += 1
            self.proxy_contact_scan_last_debug = {"skip": "scheduled_gate", "target": target_id, "source": source}
            return
        if now_ms - due_ms > 120:
            self.proxy_contact_scan_skips += 1
            self.proxy_contact_scan_last_debug = {"skip": "scheduled_late", "target": target_id, "late_ms": now_ms - due_ms, "source": source}
            return
        try:
            lead_ms = self._proxy_contact_prefire_lead_ms()
            selected_candidates, debug = self._proxy_pick_contact_targets(
                now_ms,
                max(120, lead_ms * 3),
                max(80, lead_ms * 2),
                self._proxy_contact_max_targets(),
            )
        except Exception as exc:
            self.proxy_contact_scan_skips += 1
            self.proxy_contact_scan_last_debug = {"skip": "scheduled_pick_error", "target": target_id, "error": str(exc), "source": source}
            return
        if not selected_candidates:
            self.proxy_contact_scan_skips += 1
            self.proxy_contact_scan_last_debug = {"skip": "scheduled_no_target", "target": target_id, "source": source, **debug}
            return
        best = selected_candidates[0]
        self._proxy_contact_scan_send_selected(
            now_ms,
            best,
            selected_candidates,
            debug,
            key,
            max(80, self._proxy_contact_prefire_lead_ms() * 2),
            True,
            f"scheduled:{source}",
        )

    def _proxy_contact_scan_tick(self, now_ms: int) -> None:
        if not self.crypto_active or self.server_encrypt is None:
            return
        if now_ms < self.proxy_contact_inhibit_until_ms:
            self.proxy_contact_scan_skips += 1
            self.proxy_contact_scan_last_debug = {"skip": "post_resolve_inhibit", "inhibit_ms": self.proxy_contact_inhibit_until_ms - now_ms}
            return
        self.maybe_refresh_from_board(now_ms)
        if not self.my_scene_id:
            self.proxy_contact_scan_skips += 1
            self.proxy_contact_scan_last_debug = {"skip": "no_self"}
            return
        ladder_ms = sanitize_proxy_contact_ladder_ms(self.config.proxy_contact_ladder_ms)
        step_ms = self._movement_step_ms()
        horizon_ms = self._adaptive_contact_horizon_ms()
        fire_in_ms = max(260, min(self._adaptive_contact_fire_ahead_ms(), ladder_ms + max(300, int(round(step_ms * 0.78)))))
        selected_candidates, debug = self._proxy_pick_contact_targets(
            now_ms,
            horizon_ms,
            fire_in_ms,
            self._proxy_contact_max_targets(),
        )
        if not selected_candidates:
            self.proxy_contact_scan_last_key_at.clear()
            self.proxy_contact_scan_last_contact_in_by_key.clear()
            self.proxy_contact_scan_burst_until_ms = 0
            self.proxy_contact_scan_skips += 1
            self.proxy_contact_scan_last_debug = {"skip": "no_scan_target", **debug}
            return
        best = selected_candidates[0]
        target_id = normalize_target_id(best.get("id"))
        if target_id is None:
            self.proxy_contact_scan_skips += 1
            self.proxy_contact_scan_last_debug = {"skip": "invalid_scan_target", "candidate": best, **debug}
            return
        contact = best.get("contact") or {}
        contact_eta = self._contact_eta_ms_from_candidate(best)
        fire_delay = self._fire_delay_ms_from_candidate(best)
        contact_in = contact_eta
        axis = str(contact.get("axis") or "")
        contact_self_xy = contact.get("self_xy") or []
        contact_target_xy = contact.get("target_xy") or []
        if len(contact_self_xy) >= 2 and len(contact_target_xy) >= 2:
            self_key_xy = [
                self._proxy_contact_quantize_xy(contact_self_xy[0]),
                self._proxy_contact_quantize_xy(contact_self_xy[1]),
            ]
            target_key_xy = [
                self._proxy_contact_quantize_xy(contact_target_xy[0]),
                self._proxy_contact_quantize_xy(contact_target_xy[1]),
            ]
        else:
            self_path = debug.get("self_path") or []
            target_path = best.get("path") or []
            self_key_xy = [self._proxy_contact_quantize_xy(self_path[2] if len(self_path) > 2 else 0), self._proxy_contact_quantize_xy(self_path[3] if len(self_path) > 3 else 0)]
            target_key_xy = [self._proxy_contact_quantize_xy(target_path[2] if len(target_path) > 2 else 0), self._proxy_contact_quantize_xy(target_path[3] if len(target_path) > 3 else 0)]
        key = f"{target_id}:{axis}:{self_key_xy[0]},{self_key_xy[1]}:{target_key_xy[0]},{target_key_xy[1]}"
        last_fire_delay = int(self.proxy_contact_scan_last_contact_in_by_key.get(key, 999999))
        contact_became_urgent = fire_delay <= 28 and last_fire_delay > 44
        contact_moved_closer = last_fire_delay < 999999 and fire_delay <= last_fire_delay - PROXY_CONTACT_SCAN_REARM_DELTA_MS
        hard_immediate = bool(best.get("current_allowed")) or fire_delay <= 0
        same_burst = self.proxy_contact_scan_burst_until_ms and now_ms < self.proxy_contact_scan_burst_until_ms and key == self.proxy_contact_scan_last_key
        last_key_at = int(self.proxy_contact_scan_last_key_at.get(key) or 0)
        if same_burst and not contact_became_urgent and not contact_moved_closer:
            self.proxy_contact_scan_skips += 1
            self.proxy_contact_scan_last_debug = {
                "skip": "scan_burst_cooldown",
                "target": target_id,
                "remaining_ms": self.proxy_contact_scan_burst_until_ms - now_ms,
                "contact_in_ms": contact_in,
                "contact_eta_ms": contact_eta,
                "fire_delay_ms": fire_delay,
                "last_fire_delay_ms": last_fire_delay if last_fire_delay < 999999 else None,
                "key": key,
                "candidate": best,
            }
            return
        if last_key_at and now_ms - last_key_at < PROXY_CONTACT_SCAN_KEY_TTL_MS and not contact_became_urgent and not contact_moved_closer:
            self.proxy_contact_scan_skips += 1
            self.proxy_contact_scan_last_debug = {
                "skip": "scan_duplicate",
                "target": target_id,
                "age_ms": now_ms - last_key_at,
                "contact_in_ms": contact_in,
                "contact_eta_ms": contact_eta,
                "fire_delay_ms": fire_delay,
                "last_fire_delay_ms": last_fire_delay if last_fire_delay < 999999 else None,
                "key": key,
                "candidate": best,
            }
            return
        if self.proxy_contact_scan_last_fire_at_ms and now_ms - self.proxy_contact_scan_last_fire_at_ms < PROXY_CONTACT_SCAN_GLOBAL_GAP_MS and not hard_immediate:
            self.proxy_contact_scan_skips += 1
            self.proxy_contact_scan_last_debug = {"skip": "scan_global_gap", "target": target_id, "gap_ms": now_ms - self.proxy_contact_scan_last_fire_at_ms}
            return
        if fire_delay > 0 and not hard_immediate:
            self._proxy_contact_schedule_scan_fire(now_ms, key, target_id, contact_in, best, debug, "scan")
            return
        self._proxy_contact_scan_send_selected(
            now_ms,
            best,
            selected_candidates,
            debug,
            key,
            fire_in_ms,
            hard_immediate,
            "urgent" if contact_became_urgent else ("closer" if contact_moved_closer else "new"),
        )

    def _proxy_contact_counter_from_records(self, records: List[Dict[str, object]], now_ms: int) -> None:
        if not self.config.proxy_contact_counter:
            return
        if not self.crypto_active or self.server_encrypt is None:
            return
        if now_ms < self.proxy_contact_inhibit_until_ms:
            self.proxy_contact_counter_skips += 1
            self.proxy_contact_counter_last_debug = {"skip": "post_resolve_inhibit", "inhibit_ms": self.proxy_contact_inhibit_until_ms - now_ms}
            return
        if not self.my_scene_id:
            self.proxy_contact_counter_skips += 1
            return
        my_scene_id = str(self.my_scene_id)
        self_entry = self.scene_roster.get(my_scene_id)
        if not self_entry:
            self.proxy_contact_counter_skips += 1
            return
        if not self._proxy_contact_self_confirmed(self_entry):
            self.proxy_contact_counter_skips += 1
            self.proxy_contact_counter_last_debug = {"skip": "self_unconfirmed", "self": my_scene_id, "source": self.my_scene_source or "none"}
            return
        self_x = parse_int_field(self_entry.get("x"))
        self_y = parse_int_field(self_entry.get("y"))
        if self_x is None or self_y is None:
            self.proxy_contact_counter_skips += 1
            return
        moved_ids = {str(record.get("scene_id")) for record in records if record.get("scene_id") is not None}
        if not moved_ids:
            return
        record_by_id = {str(record.get("scene_id")): record for record in records if record.get("scene_id") is not None}
        axis_mode = sanitize_proxy_contact_axis(self.config.proxy_contact_axis)
        self_record = record_by_id.get(my_scene_id)
        self_pose_age_ms = self._proxy_contact_entry_age_ms(self_entry, now_ms)
        static_self_pose = self_record is None and self._proxy_contact_static_self_pose_allowed(self_entry)
        if self_record is None and self_pose_age_ms > PROXY_CONTACT_SELF_STALE_MS and not static_self_pose:
            self.proxy_contact_counter_skips += 1
            self.proxy_contact_counter_last_debug = {"skip": "stale_self", "self": my_scene_id, "age_ms": self_pose_age_ms, "source": self.my_scene_source or "none"}
            return
        if self_record is None and self_pose_age_ms > PROXY_CONTACT_STATIC_POSE_STALE_MS and not static_self_pose:
            self.proxy_contact_counter_skips += 1
            self.proxy_contact_counter_last_debug = {"skip": "stale_self_static_pose", "self": my_scene_id, "age_ms": self_pose_age_ms, "source": self.my_scene_source or "none"}
            return
        self_path = self._proxy_contact_path(self_record, self_entry)
        if self_path is None:
            self.proxy_contact_counter_skips += 1
            return
        self_x = self_path[2]
        self_y = self_path[3]
        self_moved = my_scene_id in moved_ids
        best_target = ""
        best_score: Optional[Tuple[int, ...]] = None
        best_reason = ""
        best_x = 0
        best_y = 0
        best_dx: object = 0
        best_dy: object = 0
        best_axis = ""
        best_contact: Optional[Dict[str, object]] = None
        best_contact_in_ms = 0
        best_fire_delay_ms = 0
        best_step_ms = 0
        valid_candidates: List[Dict[str, object]] = []
        near_skips: List[Dict[str, object]] = []
        stale_skips: List[Dict[str, object]] = []
        for scene_id, entry in list(self.scene_roster.items()):
            target_id = str(scene_id)
            if target_id == my_scene_id or not self.is_probable_ring_scene_id(target_id):
                continue
            target_record = record_by_id.get(target_id)
            target_age_ms = 0 if target_record is not None else self._proxy_contact_entry_age_ms(entry, now_ms)
            if target_record is None and target_age_ms > PROXY_CONTACT_TARGET_STALE_MS:
                if len(stale_skips) < 8:
                    stale_skips.append(
                        {
                            "id": target_id,
                            "age_ms": target_age_ms,
                            "xy": [entry.get("x"), entry.get("y")],
                            "state": entry.get("state_code"),
                        }
                    )
                continue
            if target_record is None and self_moved and target_age_ms > PROXY_CONTACT_STATIC_POSE_STALE_MS:
                if len(stale_skips) < 8:
                    stale_skips.append(
                        {
                            "id": target_id,
                            "age_ms": target_age_ms,
                            "xy": [entry.get("x"), entry.get("y")],
                            "state": entry.get("state_code"),
                            "skip": "stale_static_pose",
                        }
                    )
                continue
            target_path = self._proxy_contact_path(target_record, entry)
            if target_path is None:
                continue
            target_x = target_path[2]
            target_y = target_path[3]
            final_dx = int(target_x) - int(self_x)
            final_dy = int(target_y) - int(self_y)
            start_dx = int(target_path[0]) - int(self_path[0])
            start_dy = int(target_path[1]) - int(self_path[1])
            start_dist = abs(start_dx) + abs(start_dy)
            final_dist = abs(final_dx) + abs(final_dy)
            approaching = final_dist <= start_dist
            final_axis = self._strict_punch_axis_label(int(self_x), int(self_y), int(target_x), int(target_y))
            sweep_hit = self._proxy_contact_sweep_hit(self_path, target_path, axis_mode)
            final_ok = bool(final_axis)
            if sweep_hit is not None and int(sweep_hit.get("t_pct", 100)) < 100:
                contact_kind = str(sweep_hit.get("kind") or "sweep")
                contact_pct = int(sweep_hit.get("t_pct", 50))
                contact_axis = str(sweep_hit.get("axis") or "")
                contact_dx = sweep_hit.get("dx", final_dx)
                contact_dy = sweep_hit.get("dy", final_dy)
                contact_debug = dict(sweep_hit)
                contact_debug["kind"] = contact_kind
                contact_debug["final_axis"] = final_axis
                contact_debug["final_dx"] = final_dx
                contact_debug["final_dy"] = final_dy
            elif final_ok:
                contact_kind = "final"
                contact_pct = 100
                contact_axis = final_axis
                contact_dx: object = final_dx
                contact_dy: object = final_dy
                contact_debug: Dict[str, object] = {
                    "kind": contact_kind,
                    "t_pct": contact_pct,
                    "axis": contact_axis,
                    "self_xy": [int(self_x), int(self_y)],
                    "target_xy": [int(target_x), int(target_y)],
                    "dx": contact_dx,
                    "dy": contact_dy,
                }
            elif sweep_hit is not None:
                contact_kind = str(sweep_hit.get("kind") or "sweep")
                contact_pct = int(sweep_hit.get("t_pct", 50))
                contact_axis = str(sweep_hit.get("axis") or "")
                contact_dx = sweep_hit.get("dx", final_dx)
                contact_dy = sweep_hit.get("dy", final_dy)
                contact_debug = dict(sweep_hit)
                contact_debug["kind"] = contact_kind
                contact_debug["final_axis"] = final_axis
                contact_debug["final_dx"] = final_dx
                contact_debug["final_dy"] = final_dy
            else:
                if (abs(final_dx) <= 2 and abs(final_dy) <= 2 or sweep_hit is not None) and len(near_skips) < 8:
                    near_skips.append(
                        {
                            "id": target_id,
                            "xy": [int(target_x), int(target_y)],
                            "dx": final_dx,
                            "dy": final_dy,
                            "axis": final_axis,
                        }
                    )
                continue
            target_moved = target_id in moved_ids
            candidate_step_ms = max(int(self_path[4] or 0), int(target_path[4] or 0))
            contact_pct = max(0, min(100, int(contact_pct)))
            contact_eta_value = parse_int_field(contact_debug.get("contact_eta_ms"), None)
            fire_delay_value = parse_int_field(contact_debug.get("fire_delay_ms"), None)
            contact_eta_ms = int(contact_eta_value) if contact_eta_value is not None else (int(round(float(candidate_step_ms) * float(contact_pct) / 100.0)) if candidate_step_ms > 0 else 0)
            fire_delay_ms = int(fire_delay_value) if fire_delay_value is not None else max(0, contact_eta_ms - PRECONTACT_LEAD_MS)
            contact_in_ms = contact_eta_ms
            contact_debug["step_ms"] = candidate_step_ms
            contact_debug["contact_eta_ms"] = contact_eta_ms
            contact_debug["contact_in_ms"] = contact_in_ms
            contact_debug["fire_delay_ms"] = fire_delay_ms
            if not target_moved and not self_moved:
                continue
            if target_moved and not self_moved and not approaching and not final_ok and sweep_hit is None:
                if abs(final_dx) <= 2 and abs(final_dy) <= 2 and len(near_skips) < 8:
                    near_skips.append(
                        {
                            "id": target_id,
                            "xy": [int(target_x), int(target_y)],
                            "dx": final_dx,
                            "dy": final_dy,
                            "axis": final_axis,
                            "skip": "moving_away",
                            "start_dist": start_dist,
                            "final_dist": final_dist,
                        }
                    )
                continue
            last_seen = entry.get("last_seen_ts_ms")
            last_seen_age = now_ms - int(last_seen) if isinstance(last_seen, int) else 999999
            if not target_moved and last_seen_age > 45000 and not entry.get("seen_in_scene_frame"):
                continue
            if target_moved and self_moved:
                move_rank = 0
                reason = "batch_both_final"
            elif target_moved:
                move_rank = 1
                reason = "enemy_final"
            else:
                move_rank = 2
                reason = "self_final"
            if contact_kind.startswith("sweep"):
                reason = reason.replace("_final", "_sweep")
            distance_score = int(round((abs(float(contact_dx)) + abs(float(contact_dy))) * 100))
            axis_rank = 1 if contact_axis.startswith("CARDINAL_SIDE") else 0
            kind_rank = 0 if contact_kind == "final" else 1
            approach_rank = 0 if target_moved and (approaching or final_ok or sweep_hit is not None) else 1
            seen_rank = min(999, max(0, last_seen_age // 100))
            try:
                id_rank = int(target_id)
            except ValueError:
                id_rank = 9999
            score = (approach_rank, fire_delay_ms, contact_eta_ms, kind_rank, distance_score, axis_rank, move_rank, seen_rank, id_rank)
            candidate = {
                "id": target_id,
                "xy": [int(target_x), int(target_y)],
                "from_xy": [int(target_path[0]), int(target_path[1])],
                "dx": contact_dx,
                "dy": contact_dy,
                "axis": contact_axis,
                "kind": contact_kind,
                "contact": contact_debug,
                "contact_pct": contact_pct,
                "contact_in_ms": contact_in_ms,
                "contact_eta_ms": contact_eta_ms,
                "fire_delay_ms": fire_delay_ms,
                "step_ms": candidate_step_ms,
                "final_dx": final_dx,
                "final_dy": final_dy,
                "final_axis": final_axis,
                "start_dist": start_dist,
                "final_dist": final_dist,
                "approaching": approaching,
                "moved": target_moved,
                "score": list(score),
                "age_ms": last_seen_age if last_seen_age < 999999 else None,
            }
            valid_candidates.append(candidate)
            if best_score is None or score < best_score:
                best_score = score
                best_target = target_id
                best_reason = reason
                best_x = int(target_x)
                best_y = int(target_y)
                best_dx = contact_dx
                best_dy = contact_dy
                best_axis = contact_axis
                best_contact = contact_debug
                best_contact_in_ms = contact_in_ms
                best_fire_delay_ms = fire_delay_ms
                best_step_ms = candidate_step_ms
        if not best_target:
            self.proxy_contact_counter_skips += 1
            self.proxy_contact_counter_last_debug = {
                "skip": "no_contact_candidate",
                "axis_mode": axis_mode,
                "self_xy": [int(self_x), int(self_y)],
                "self_source": self.my_scene_source or "none",
                "self_static_pose": static_self_pose,
                "self_age_ms": self._proxy_contact_entry_age_ms(self_entry, now_ms),
                "self_path": [self_path[0], self_path[1], self_path[2], self_path[3]],
                "moved_ids": sorted(moved_ids),
                "near_skips": near_skips,
                "stale_skips": stale_skips,
            }
            return
        valid_candidates.sort(key=lambda item: tuple(item.get("score") or [999999]))
        selected_candidates = self._compatible_contact_candidates(valid_candidates, 1)
        selected_targets = [str(item.get("id")) for item in selected_candidates if normalize_target_id(item.get("id")) is not None]
        if not selected_targets:
            self.proxy_contact_counter_skips += 1
            self.proxy_contact_counter_last_debug = {"skip": "no_valid_fanout_targets", "axis_mode": axis_mode, "candidates": valid_candidates[:6]}
            return
        best_reason = f"{best_reason} {best_axis} nearest dx={best_dx} dy={best_dy}"
        min_gap = sanitize_proxy_contact_gap_ms(self.config.proxy_contact_min_gap_ms)
        key = f"{','.join(selected_targets)}:{self_x},{self_y}:{best_x},{best_y}:{','.join(sorted(moved_ids))}"
        if min_gap > 0 and now_ms - self.proxy_contact_counter_last_fire_at_ms < min_gap:
            self.proxy_contact_counter_skips += 1
            self.proxy_contact_counter_last_debug = {"skip": "min_gap", "axis_mode": axis_mode, "target_id": best_target, "gap_ms": now_ms - self.proxy_contact_counter_last_fire_at_ms}
            return
        if min_gap > 0 and key == self.proxy_contact_counter_last_key and now_ms - self.proxy_contact_counter_last_fire_at_ms < 90:
            self.proxy_contact_counter_skips += 1
            self.proxy_contact_counter_last_debug = {"skip": "duplicate_key", "axis_mode": axis_mode, "target_id": best_target}
            return
        if best_fire_delay_ms > 0:
            fire_ahead_ms = self._adaptive_contact_fire_ahead_ms()
            schedule_debug = {
                "axis_mode": axis_mode,
                "self_xy": [int(self_x), int(self_y)],
                "self_source": self.my_scene_source or "none",
                "self_static_pose": static_self_pose,
                "self_age_ms": self._proxy_contact_entry_age_ms(self_entry, now_ms),
                "target_xy": [best_x, best_y],
                "dx": best_dx,
                "dy": best_dy,
                "axis": best_axis,
                "contact": best_contact,
                "contact_in_ms": best_contact_in_ms,
                "contact_eta_ms": best_contact_in_ms,
                "fire_delay_ms": best_fire_delay_ms,
                "step_ms": best_step_ms,
                "fire_ahead_ms": fire_ahead_ms,
                "candidates": valid_candidates[:6],
                "near_skips": near_skips,
                "stale_skips": stale_skips,
            }
            if best_fire_delay_ms <= fire_ahead_ms:
                scheduled = self._proxy_contact_schedule_scan_fire(
                    now_ms,
                    key,
                    best_target,
                    best_contact_in_ms,
                    selected_candidates[0],
                    schedule_debug,
                    "counter",
                )
                if scheduled:
                    self.proxy_contact_counter_last_debug = {
                        "schedule": "counter",
                        "target_id": best_target,
                        "targets": selected_targets,
                        **schedule_debug,
                    }
                    return
            self.proxy_contact_counter_skips += 1
            self.proxy_contact_counter_last_debug = {
                "skip": "counter_future_contact",
                "target_id": best_target,
                "targets": selected_targets,
                **schedule_debug,
            }
            return
        try:
            frames_by_target = {target_id: build_punch_frame(target_id) for target_id in selected_targets}
        except ValueError:
            self.proxy_contact_counter_skips += 1
            self.proxy_contact_counter_last_debug = {"skip": "invalid_target", "axis_mode": axis_mode, "targets": selected_targets}
            return
        copies = sanitize_proxy_contact_copies(self.config.proxy_contact_copies)
        ladder_ms = sanitize_proxy_contact_ladder_ms(self.config.proxy_contact_ladder_ms)
        ladder_steps = sanitize_proxy_contact_ladder_steps(self.config.proxy_contact_ladder_steps)
        scheduled_batches = self._queue_proxy_contact_ladder(selected_targets, frames_by_target, copies, ladder_ms, ladder_steps)
        if scheduled_batches <= 0:
            self.proxy_contact_counter_skips += 1
            self.proxy_contact_counter_last_debug = {"skip": "send_failed", "axis_mode": axis_mode, "targets": selected_targets}
            return
        total_copies = copies * len(selected_targets) * scheduled_batches
        self.proxy_contact_counter_fires += 1
        self.proxy_contact_counter_last_fire_at_ms = now_ms
        self.proxy_contact_counter_last_key = key
        self.proxy_contact_counter_last_target = best_target
        self.proxy_contact_counter_last_reason = best_reason + (f" fanout={len(selected_targets)}" if len(selected_targets) > 1 else "") + (f" ladder={ladder_ms}x{scheduled_batches}" if scheduled_batches > 1 else "")
        self.proxy_contact_counter_last_debug = {
            "target_id": best_target,
            "targets": selected_targets,
            "fanout": len(selected_targets),
            "ladder_ms": ladder_ms,
            "ladder_steps": scheduled_batches,
            "axis_mode": axis_mode,
            "self_xy": [int(self_x), int(self_y)],
            "self_source": self.my_scene_source or "none",
            "self_static_pose": static_self_pose,
            "self_age_ms": self._proxy_contact_entry_age_ms(self_entry, now_ms),
            "target_xy": [best_x, best_y],
            "dx": best_dx,
            "dy": best_dy,
            "axis": best_axis,
            "contact": best_contact,
            "score": list(best_score) if best_score is not None else None,
            "candidates": valid_candidates[:6],
            "near_skips": near_skips,
            "stale_skips": stale_skips,
        }
        self.registry.add_event(
            {
                "type": "PROXY_CONTACT_COUNTER_FIRE",
                "session_id": self.session_id,
                "target_id": best_target,
                "targets": selected_targets,
                "reason": self.proxy_contact_counter_last_reason,
                "copies": copies,
                "total_copies": total_copies,
                "ladder_ms": ladder_ms,
                "ladder_steps": scheduled_batches,
                "self_scene_id": my_scene_id,
                "self_source": self.my_scene_source or "none",
                "self_age_ms": self._proxy_contact_entry_age_ms(self_entry, now_ms),
                "self_xy": [int(self_x), int(self_y)],
                "target_xy": [best_x, best_y],
                "dx": best_dx,
                "dy": best_dy,
                "axis": best_axis,
                "axis_mode": axis_mode,
                "contact": best_contact,
                "candidates": valid_candidates[:6],
                "near_skips": near_skips,
                "moved_ids": sorted(moved_ids),
                "gap_ms": now_ms - self.proxy_contact_counter_last_batch_ms if self.proxy_contact_counter_last_batch_ms else None,
            }
        )
        self.proxy_contact_counter_last_batch_ms = now_ms
        if self.config.verbose:
            self.log(f"PROXY_CONTACT target={best_target} targets={','.join(selected_targets)} reason={self.proxy_contact_counter_last_reason} copies={copies}", console=True)

    def _update_roster_from_state146(self, fields: List[str], now_ms: int) -> None:
        data = self._normalize_frame_fields(fields)
        if len(data) < 4:
            return
        account_id = str(data[0])
        if not self.is_account_player_id(account_id):
            return
        payload = {
            "state_code": data[1],
            "state_arg1": data[2] if len(data) > 2 else None,
            "state_arg2": data[3] if len(data) > 3 else None,
            "ts_ms": now_ms,
        }
        self.account_state_cache[account_id] = payload
        scene_id = self.account_to_scene_id.get(account_id)
        if scene_id:
            entry = self._roster_entry(scene_id)
            old_state = self._proxy_release_state_int(entry.get("state_code"))
            new_state = self._proxy_release_state_int(payload["state_code"])
            entry["account_id"] = account_id
            entry["state_code"] = payload["state_code"]
            entry["state_arg1"] = payload["state_arg1"]
            entry["state_arg2"] = payload["state_arg2"]
            entry["last_seen_ts_ms"] = now_ms
            entry["seen_in_state"] = True
            self._apply_memory_labels(entry, account_id)
            if str(scene_id) == str(self.my_scene_id) or account_id == self.my_player_id:
                self._proxy_release_counter_start(old_state, new_state, now_ms, source="state146")

    def combatant_snapshot(self) -> List[Dict[str, object]]:
        now_ms = int(time.time() * 1000)
        items: List[Dict[str, object]] = []
        for item in self.roster_snapshot():
            scene_id = str(item.get("scene_id") or "")
            if not scene_id.isdigit():
                continue
            last_seen_ts_ms = item.get("last_seen_ts_ms")
            recent_seen = isinstance(last_seen_ts_ms, int) and (now_ms - last_seen_ts_ms) <= 45000
            has_pose = item.get("x") is not None and item.get("y") is not None and item.get("orientation") is not None
            active_signal = bool(
                item.get("is_self")
                or item.get("moving_recent")
                or item.get("state_code") is not None
                or item.get("seen_in_scene_frame")
                or recent_seen
            )
            if not (self.is_probable_ring_scene_id(scene_id) and has_pose and active_signal):
                continue
            reason_parts: List[str] = []
            if item.get("is_self"):
                reason_parts.append("self")
            if item.get("moving_recent"):
                reason_parts.append("moving")
            if item.get("state_code") is not None:
                reason_parts.append("state")
            if item.get("seen_in_scene_frame"):
                reason_parts.append("scene")
            if recent_seen:
                reason_parts.append("seen")
            enriched = dict(item)
            enriched["active_reason"] = ",".join(reason_parts) if reason_parts else "seen"
            items.append(enriched)
        if len(items) > 8:
            items.sort(
                key=lambda item: (
                    0 if item.get("is_self") else 1,
                    -(int(item.get("last_seen_ts_ms") or 0)),
                    0 if item.get("account_id") else 1,
                    int(item["scene_id"]) if str(item.get("scene_id", "")).isdigit() else 9999,
                )
            )
            items = items[:8]
            items.sort(
                key=lambda item: (
                    0 if item.get("is_self") else 1,
                    int(item["scene_id"]) if str(item.get("scene_id", "")).isdigit() else 9999,
                    str(item.get("name") or ""),
                )
            )
        return items

    def roster_snapshot(self) -> List[Dict[str, object]]:
        now_ms = int(time.time() * 1000)
        players: List[Dict[str, object]] = []
        for scene_id, entry in self.scene_roster.items():
            if not self.is_probable_ring_scene_id(str(scene_id)):
                continue
            item = dict(entry)
            self._apply_memory_labels(item, item.get("account_id"))
            last_move_ts_ms = item.get("last_move_ts_ms")
            if isinstance(last_move_ts_ms, int):
                item["last_move_ago_ms"] = max(0, now_ms - last_move_ts_ms)
                item["moving_recent"] = now_ms - last_move_ts_ms <= 1500
            else:
                item["last_move_ago_ms"] = None
                item["moving_recent"] = False
            item["is_self"] = scene_id == self.my_scene_id
            players.append(item)
        if len(players) > 8:
            ranked = sorted(
                players,
                key=lambda item: (
                    0 if item.get("is_self") else 1,
                    -(int(item.get("last_seen_ts_ms") or 0)),
                    0 if item.get("account_id") else 1,
                    int(item["scene_id"]) if str(item.get("scene_id", "")).isdigit() else 9999,
                ),
            )
            keep_scene_ids = {str(item.get("scene_id")) for item in ranked[:8]}
            players = [item for item in players if str(item.get("scene_id")) in keep_scene_ids]
        players.sort(
            key=lambda item: (
                0 if item.get("is_self") else 1,
                int(item["scene_id"]) if str(item.get("scene_id", "")).isdigit() else 9999,
                str(item.get("name") or ""),
            )
        )
        return players

    def track_ring_ids_from_frame(self, frame: bytes) -> None:
        """Extract player IDs from downstream frames (HP updates, score, etc)."""
        opcode = extract_opcode(frame)
        if not self.config.detailed_events and opcode not in self.LOW_LATENCY_DOWN_OPCODES:
            return
        fields = parse_plaintext_frame(frame)
        now_ms = int(time.time() * 1000)
        self.maybe_refresh_from_board(now_ms)
        if opcode in ((120, 121), (128, 122)):
            if len(fields) >= 28:
                self._update_roster_from_scene_person_frame(fields, now_ms)
                scene_id, account_id, player_name = self.extract_player_mapping_from_fields(fields)
                if scene_id and account_id:
                    self.register_player_mapping(scene_id, account_id, player_name)
                else:
                    if scene_id and self.my_player_id is None and self.pending_self_scene_candidate is None:
                        self.pending_self_scene_candidate = (scene_id, player_name, now_ms)
                    self.registry.add_event(
                        {
                            "type": "PLAYER_MAP_CANDIDATE",
                            "scene_id_candidate": scene_id or "?",
                            "player_name": player_name or "",
                            "field_candidates": {
                                str(idx): fields[idx] for idx in range(20, min(len(fields), 34))
                            },
                            "my_account_id": self.my_player_id or "?",
                            "my_scene_id": self.my_scene_id or "?",
                        }
                    )
            else:
                self._update_roster_from_short_name_frame(fields, now_ms)
        if opcode == (134,) and len(fields) >= 3:
            scene_id = fields[1]
            account_id = fields[2]
            if self.is_scene_player_id(scene_id) and self.is_probable_ring_scene_id(scene_id):
                self.ring_player_ids.add(scene_id)
                if self.my_player_id and account_id == self.my_player_id:
                    self.my_scene_id = scene_id
                    self.my_scene_source = "opcode134"
                    self.has_seen_ring_resolve = False  # Reset on scene mapping
                    entry = self._roster_entry(scene_id)
                    entry["account_id"] = account_id
                    entry["last_seen_ts_ms"] = now_ms
                    self.registry.add_event(
                        {
                            "type": "MY_SCENE_ID_OPCODE134",
                            "scene_id": scene_id,
                            "account_id": account_id,
                        }
                    )
        if opcode == (184, 120) and len(fields) >= 2:
            pid = fields[1]
            if self.is_scene_player_id(pid) and self.is_probable_ring_scene_id(pid):
                self.has_seen_ring_resolve = True  # set ring active
                if pid not in self.ring_player_ids:
                    self.ring_player_ids.add(pid)
                    self.log(f"RING player detected: {pid} (total={len(self.ring_player_ids)})", console=self.config.verbose)
        if opcode == (182,) and len(fields) >= 2:
            step_records = self._parse_step_records(fields, now_ms)
            self._update_roster_from_step_records(step_records, now_ms)
            self._proxy_contact_counter_from_records(step_records, now_ms)
            # --- Contact V6: pre-queue punch on movement detection ---
            self._prequeue_punch_on_step(step_records, now_ms)
            if self.config.packet_brain:
                self._packet_brain_fire_from_roster(
                    now_ms,
                    "down182",
                    PACKET_BRAIN_DOWN_MOVE_OFFSETS_MS,
                    self._adaptive_contact_horizon_ms(),
                    self._adaptive_contact_fire_ahead_ms(),
                )
            self.record_context_event(
                {
                    "kind": "STEP_RX",
                    "opcode": list(opcode),
                    "fields": fields[1:8],
                    "records": [
                        {
                            "scene_id": record.get("scene_id"),
                            "from": [record.get("from_x"), record.get("from_y")],
                            "to": [record.get("x"), record.get("y")],
                            "orientation": record.get("orientation"),
                            "step_ms": record.get("step_ms"),
                        }
                        for record in step_records[:8]
                    ],
                },
                now_ms,
            )
        elif opcode in ((146,), (144,), (161,), (175,), (125, 120), (200, 122)):
            if opcode == (146,):
                self._update_roster_from_state146(fields, now_ms)
            self.record_context_event(
                {
                    "kind": "DOWN_OPCODE",
                    "opcode": list(opcode),
                    "fields": fields[1:8],
                },
                now_ms,
            )
        if opcode == (200, 122) and len(fields) >= 2 and self.my_player_id is None:
            pid = fields[1]
            if self.is_account_player_id(pid):
                self.my_player_id = pid
                self.log(f"MY account ID: {pid}", console=self.config.verbose)
                self.maybe_update_my_scene_id()
        # Log RESOLVE events (opcode 211 downstream)
        if opcode == (211,) and len(fields) >= 10:
            self.has_seen_ring_resolve = True  # set ring active
            evt = {
                "type": "RESOLVE",
                "atkFx": fields[2], "atk_id": fields[3],
                "atk_x": fields[4], "atk_y": fields[5],
                "defFx": fields[6], "def_id": fields[7],
                "def_x": fields[8], "def_y": fields[9],
                "my_id": self.my_player_id or "?",
                "my_scene_id": self.my_scene_id or "?",
                "all_fields": fields[:16],
            }
            self._packet_brain_cut_after_resolve(evt, now_ms)
            match = self._match_resolve_to_punch(evt, now_ms)
            if match is not None:
                evt["matched_seq"] = match["seq"]
                evt["matched_target_id"] = match["target_id"]
                evt["matched_role"] = match["role"]
                evt["matched_latency_ms"] = match["latency_ms"]
                evt["matched_source"] = match["source"]
                evt["matched_late"] = match["late"]
                self.emit_resolve_context(evt, match, now_ms)
            elif self.my_scene_id and self.my_scene_id in (evt["atk_id"], evt["def_id"]):
                unmatched_target_id = evt["def_id"] if evt["atk_id"] == self.my_scene_id else evt["atk_id"]
                self.emit_resolve_context(
                    evt,
                    {
                        "seq": None,
                        "target_id": unmatched_target_id,
                        "source": "unmatched",
                        "copy_index": None,
                        "copy_total": None,
                        "move_attached": None,
                        "latency_ms": None,
                        "role": "self_unmatched",
                        "late": False,
                    },
                    now_ms,
                )
            self.registry.add_event(evt)
        # Log ALL downstream opcodes for analysis
        if len(fields) >= 1:
            self.registry.add_event({
                "type": "DOWN",
                "opcode": list(opcode),
                "fields_count": len(fields),
                "fields_preview": fields[:6],
            })

    def detect_my_id_from_upstream(self, frame: bytes) -> None:
        """Try to detect our own player ID from upstream punch targets (elimination)."""
        pass

    def direct_punch_target(self) -> None:
        """Send move+punch directly from Python. The move resets server punch cooldown."""
        if not self.crypto_active:
            return
        punch = self.flood_frame
        if punch is None:
            return
        try:
            payload = bytearray()
            if self.last_move_frame:
                payload.extend(self.last_move_frame)
            payload.extend(punch)
            with self.upstream_lock:
                encrypted = self.server_encrypt.crypt(bytes(payload))
                self.remote_sock.sendall(encrypted)
            self.punches_injected += 1
            self._record_punch_send(
                target_id=self.flood_target,
                source="direct",
                copy_index=1,
                copy_total=1,
                move_attached=self.last_move_frame is not None,
            )
        except (ConnectionError, OSError) as e:
            self.log(f"DIRECT punch failed: {e}")

    def start_hotkey_flood(self) -> None:
        """Start continuous punch flood to captured target (F1 held)."""
        if self.hotkey_active:
            return
        if not self.flood_frame:
            self.log("F1 ignored - no target captured yet (punch someone first)")
            return
        self.hotkey_active = True
        if self.hotkey_thread is None or not self.hotkey_thread.is_alive():
            self.hotkey_thread = threading.Thread(target=self._hotkey_flood_loop, daemon=True)
            self.hotkey_thread.start()
            self.log(f"F1 FLOOD ON -> target={self.flood_target}")

    def stop_hotkey_flood(self) -> None:
        """Stop continuous punch flood (F1 released)."""
        if self.hotkey_active:
            self.hotkey_active = False
            self.log(f"F1 FLOOD OFF total_injected={self.punches_injected}")

    def _hotkey_flood_loop(self) -> None:
        try:
            while self.hotkey_active and self.crypto_active:
                self.direct_punch_target()
                time.sleep(0.035)  # ~28/sec with move+punch pairs
        except (ConnectionError, OSError):
            pass
        self.hotkey_active = False

    def _start_flood(self) -> None:
        if self.flood_thread is not None:
            return
        self.flood_active = True
        self.flood_thread = threading.Thread(target=self._flood_loop, daemon=True)
        self.flood_thread.start()
        self.log(f"FLOOD started target={self.flood_target} interval={self.config.flood_interval}s")

    def _stop_flood(self) -> None:
        self.flood_active = False
        self.flood_thread = None
        self.log(f"FLOOD stopped total={self.flood_punches}")

    def _flood_loop(self) -> None:
        interval = self.config.flood_interval if self.config.flood_interval > 0 else 0.05
        try:
            while self.flood_active and self.crypto_active:
                frame = self.flood_frame
                if frame is None:
                    time.sleep(0.1)
                    continue
                with self.upstream_lock:
                    encrypted = self.server_encrypt.crypt(frame)
                    self.remote_sock.sendall(encrypted)
                self.flood_punches += 1
                self.punches_injected += 1
                self._record_punch_send(
                    target_id=self.flood_target,
                    source="flood",
                    copy_index=1,
                    copy_total=1,
                    move_attached=False,
                )
                time.sleep(interval)
        except (ConnectionError, OSError):
            pass
        self.flood_active = False

    def _current_move_punch_frame(self) -> Tuple[Optional[str], Optional[bytes]]:
        target = normalize_target_id(self.config.move_punch_target) or normalize_target_id(self.flood_target)
        if target is None:
            return None, None
        if self.flood_frame is not None and normalize_target_id(self.flood_target) == target:
            return target, self.flood_frame
        try:
            return target, build_punch_frame(target)
        except ValueError:
            return None, None

    def _record_move_punch_send(self, target: str, copies: int, delayed: bool, source_prefix: str = "move_punch", move_attached: bool = True) -> None:
        self.punches_injected += copies
        source = f"{source_prefix}_delay" if delayed else source_prefix
        for idx in range(copies):
            self._record_punch_send(
                target_id=target,
                source=source,
                copy_index=idx + 1,
                copy_total=copies,
                move_attached=move_attached,
            )

    def _send_delayed_move_punch(self, target: str, frame: bytes, copies: int, delay_ms: int, source_prefix: str = "move_punch", move_attached: bool = True) -> None:
        if not self.crypto_active or self.server_encrypt is None:
            return
        payload = frame * copies
        try:
            with self.upstream_lock:
                encrypted = self.server_encrypt.crypt(payload)
                self.remote_sock.sendall(encrypted)
            self._record_move_punch_send(target, copies, delayed=delay_ms > 0, source_prefix=source_prefix, move_attached=move_attached)
            if self.config.verbose:
                self.log(f"{source_prefix.upper()} sent target={target} copies={copies} delay={delay_ms}ms", console=True)
        except (ConnectionError, OSError) as exc:
            self.log(f"{source_prefix.upper()} failed: {exc}", console=self.config.verbose)

    def _queue_move_punch_sweep(
        self,
        target: str,
        frame: bytes,
        copies: int,
        delay_ms: int,
        spacing_ms: int,
        source_prefix: str = "move_punch",
        out: Optional[bytearray] = None,
        move_attached: bool = True,
    ) -> None:
        if copies <= 1 or spacing_ms <= 0:
            if delay_ms > 0 or out is None:
                timer = threading.Timer(delay_ms / 1000.0, self._send_delayed_move_punch, args=(target, frame, copies, delay_ms, source_prefix, move_attached))
                timer.daemon = True
                timer.start()
            else:
                for _idx in range(copies):
                    out.extend(frame)
                self._record_move_punch_send(target, copies, delayed=False, source_prefix=source_prefix, move_attached=move_attached)
            return
        for idx in range(copies):
            item_delay_ms = delay_ms + idx * spacing_ms
            if item_delay_ms > 0 or out is None:
                timer = threading.Timer(item_delay_ms / 1000.0, self._send_delayed_move_punch, args=(target, frame, 1, item_delay_ms, source_prefix, move_attached))
                timer.daemon = True
                timer.start()
            else:
                out.extend(frame)
                self._record_move_punch_send(target, 1, delayed=False, source_prefix=source_prefix, move_attached=move_attached)

    def _append_move_punch_after_move(self, out: bytearray) -> None:
        if not self.config.move_punch:
            return
        target, frame = self._current_move_punch_frame()
        if target is None or frame is None:
            now = time.time()
            if now - self.last_move_punch_no_target_log_at >= 2.0:
                self.last_move_punch_no_target_log_at = now
                self.log("MOVE_PUNCH skipped: no captured/manual target", console=self.config.verbose)
                self.registry.add_event(
                    {
                        "type": "MOVE_PUNCH_SKIPPED",
                        "session_id": self.session_id,
                        "reason": "no_target",
                    }
            )
            return
        copies = sanitize_multiply(self.config.move_punch_copies)
        delay_ms = sanitize_delay_ms(self.config.move_punch_delay_ms)
        spacing_ms = sanitize_delay_ms(self.config.move_punch_spacing_ms)
        self._queue_move_punch_sweep(target, frame, copies, delay_ms, spacing_ms, "move_punch", out)
        if self.config.verbose:
            self.log(f"MOVE_PUNCH target={target} copies={copies} delay={delay_ms}ms spacing={spacing_ms}ms", console=True)

    def _send_step_punch_from_step(self, frame: bytes) -> None:
        if not self.config.step_punch:
            return
        if extract_opcode(frame) != (182,):
            return
        fields = parse_plaintext_frame(frame)
        if len(fields) < 2:
            return
        step_scene_id = str(fields[1])
        if not self.my_scene_id or step_scene_id != str(self.my_scene_id):
            return
        target, punch_frame = self._current_move_punch_frame()
        if target is None or punch_frame is None:
            now = time.time()
            if now - self.last_step_punch_no_target_log_at >= 2.0:
                self.last_step_punch_no_target_log_at = now
                self.log("STEP_PUNCH skipped: no captured/manual target", console=self.config.verbose)
                self.registry.add_event(
                    {
                        "type": "STEP_PUNCH_SKIPPED",
                        "session_id": self.session_id,
                        "reason": "no_target",
                        "my_scene_id": self.my_scene_id or "?",
                    }
                )
            return
        copies = sanitize_multiply(self.config.move_punch_copies)
        delay_ms = sanitize_delay_ms(self.config.move_punch_delay_ms)
        spacing_ms = sanitize_delay_ms(self.config.move_punch_spacing_ms)
        self._queue_move_punch_sweep(target, punch_frame, copies, delay_ms, spacing_ms, "step_punch")
        if self.config.verbose:
            self.log(f"STEP_PUNCH target={target} copies={copies} delay={delay_ms}ms spacing={spacing_ms}ms", console=True)

    def _append_echo_punch_after_client_punch(self, target: Optional[str], frame: bytes, out: bytearray) -> None:
        if not self.config.echo_punch:
            return
        target = normalize_target_id(target)
        if target is None:
            return
        copies = sanitize_extra_copies(self.config.echo_punch_copies)
        if copies <= 0:
            return
        delay_ms = sanitize_delay_ms(self.config.echo_punch_delay_ms)
        spacing_ms = sanitize_delay_ms(self.config.echo_punch_spacing_ms)
        self._queue_move_punch_sweep(target, frame, copies, delay_ms, spacing_ms, "echo_punch", out, move_attached=False)
        if self.config.verbose:
            self.log(f"ECHO_PUNCH target={target} copies={copies} delay={delay_ms}ms spacing={spacing_ms}ms", console=True)

    def _actor_tuple_from_release_path(self, entry: Dict[str, object], now_ms: int) -> Optional[Tuple[float, float, float, float, int]]:
        actor_path = self._proxy_release_actor_path(entry, now_ms)
        if actor_path is None:
            return None
        from_x, from_y = self._proxy_release_point_at(actor_path, now_ms)
        to_x = float(actor_path.get("to_x") or from_x)
        to_y = float(actor_path.get("to_y") or from_y)
        end_ms = int(actor_path.get("end_ms") or now_ms)
        remaining_ms = max(0, end_ms - now_ms)
        return from_x, from_y, to_x, to_y, remaining_ms

    def _proxy_move_brain_candidates(self, frame: bytes, now_ms: int) -> Tuple[List[Dict[str, object]], Dict[str, object]]:
        if not self.my_scene_id:
            return [], {"skip": "no_self"}
        my_scene_id = str(self.my_scene_id)
        self_entry = self.scene_roster.get(my_scene_id)
        if not self_entry:
            return [], {"skip": "no_self_entry", "self": my_scene_id}
        if not self._proxy_contact_self_confirmed(self_entry):
            return [], {"skip": "self_unconfirmed", "self": my_scene_id, "source": self.my_scene_source or "none"}
        fields = parse_plaintext_frame(frame)
        records = self._parse_step_records(fields, now_ms)
        self_record = next((record for record in records if str(record.get("scene_id")) == my_scene_id), None)
        if self_record is None and len(records) == 1:
            only = dict(records[0])
            only["scene_id"] = my_scene_id
            self_record = only
        if self_record is None:
            return [], {
                "skip": "no_self_move_record",
                "self": my_scene_id,
                "fields": fields[:8],
                "records": records[:4],
            }
        self_path_raw = self._proxy_contact_path(self_record, self_entry)
        if self_path_raw is None:
            return [], {"skip": "no_self_move_path", "self": my_scene_id, "record": self_record}
        step_ms = int(self_path_raw[4] or self._movement_step_ms())
        self_path: Tuple[float, float, float, float, int] = (
            float(self_path_raw[0]),
            float(self_path_raw[1]),
            float(self_path_raw[2]),
            float(self_path_raw[3]),
            step_ms,
        )
        axis_mode = sanitize_proxy_contact_axis(self.config.proxy_contact_axis)
        sx0, sy0, sx1, sy1, _self_step = self_path
        candidates: List[Dict[str, object]] = []
        near_skips: List[Dict[str, object]] = []
        stale_skips: List[Dict[str, object]] = []
        for scene_id, entry in list(self.scene_roster.items()):
            target_id = str(scene_id)
            if target_id == my_scene_id or not self.is_probable_ring_scene_id(target_id):
                continue
            target_age_ms = self._proxy_contact_entry_age_ms(entry, now_ms)
            if target_age_ms > PROXY_CONTACT_TARGET_STALE_MS:
                if len(stale_skips) < 8:
                    stale_skips.append({"id": target_id, "age_ms": target_age_ms, "xy": [entry.get("x"), entry.get("y")]})
                continue
            target_path = self._actor_tuple_from_release_path(entry, now_ms)
            if target_path is None:
                continue
            tx0, ty0, tx1, ty1, target_remaining_ms = target_path
            final_axis = self._strict_punch_axis_label(int(round(sx1)), int(round(sy1)), int(round(tx1)), int(round(ty1)))
            sweep_hit = self._proxy_contact_sweep_hit(self_path, target_path, axis_mode)
            if sweep_hit is not None:
                contact = dict(sweep_hit)
                contact_kind = str(contact.get("kind") or "sweep")
                contact_pct = max(0, min(100, int(contact.get("t_pct", 50))))
                contact_axis = str(contact.get("axis") or final_axis)
                contact_dx = float(contact.get("dx") or 0.0)
                contact_dy = float(contact.get("dy") or 0.0)
                contact_eta_value = parse_int_field(contact.get("contact_eta_ms"), None)
                fire_delay_value = parse_int_field(contact.get("fire_delay_ms"), None)
                contact_eta_ms = int(contact_eta_value) if contact_eta_value is not None else int(round(float(max(step_ms, target_remaining_ms)) * float(contact_pct) / 100.0))
                fire_delay_ms = int(fire_delay_value) if fire_delay_value is not None else max(0, contact_eta_ms - PRECONTACT_LEAD_MS)
                contact_in_ms = contact_eta_ms
            elif final_axis:
                contact_kind = "final"
                contact_pct = 100
                contact_axis = final_axis
                contact_dx = float(tx1 - sx1)
                contact_dy = float(ty1 - sy1)
                contact_eta_ms = max(step_ms, target_remaining_ms)
                fire_delay_ms = max(0, contact_eta_ms - PRECONTACT_LEAD_MS)
                contact_in_ms = contact_eta_ms
                contact = {
                    "kind": contact_kind,
                    "t_pct": contact_pct,
                    "axis": contact_axis,
                    "self_xy": [round(sx1, 3), round(sy1, 3)],
                    "target_xy": [round(tx1, 3), round(ty1, 3)],
                    "dx": round(contact_dx, 3),
                    "dy": round(contact_dy, 3),
                    "contact_eta_ms": contact_eta_ms,
                    "fire_delay_ms": fire_delay_ms,
                }
            else:
                dx_now = tx0 - sx0
                dy_now = ty0 - sy0
                dx_final = tx1 - sx1
                dy_final = ty1 - sy1
                if len(near_skips) < 8 and (abs(dx_now) <= 2.0 and abs(dy_now) <= 2.0 or abs(dx_final) <= 2.0 and abs(dy_final) <= 2.0):
                    near_skips.append(
                        {
                            "id": target_id,
                            "now": [round(dx_now, 3), round(dy_now, 3)],
                            "final": [round(dx_final, 3), round(dy_final, 3)],
                            "axis": final_axis,
                        }
                    )
                continue
            state_code = self._proxy_release_state_int(entry.get("state_code"))
            state_rank = 0 if state_code in (2, 3, 7, 8, 9, 10, 14) else (1 if state_code is None else 2)
            current_distance = abs(tx0 - sx0) + abs(ty0 - sy0)
            contact_distance = abs(contact_dx) + abs(contact_dy)
            score = (
                0 if fire_delay_ms <= self._adaptive_contact_fire_ahead_ms() else 1,
                fire_delay_ms,
                contact_eta_ms,
                int(round(contact_distance * 100)),
                int(round(current_distance * 100)),
                state_rank,
                min(999, max(0, target_age_ms // 50)),
                int(target_id) if target_id.isdigit() else 9999,
            )
            contact["contact_eta_ms"] = contact_eta_ms
            contact["fire_delay_ms"] = fire_delay_ms
            contact["contact_in_ms"] = contact_in_ms
            contact["step_ms"] = step_ms
            contact["target_remaining_ms"] = target_remaining_ms
            contact["final_axis"] = final_axis
            candidates.append(
                {
                    "id": target_id,
                    "score": list(score),
                    "contact": contact,
                    "kind": contact_kind,
                    "axis": contact_axis,
                    "contact_in_ms": contact_in_ms,
                    "contact_eta_ms": contact_eta_ms,
                    "fire_delay_ms": fire_delay_ms,
                    "state": state_code,
                    "target_age_ms": target_age_ms if target_age_ms < 999999 else None,
                    "self_path": [round(sx0, 3), round(sy0, 3), round(sx1, 3), round(sy1, 3)],
                    "target_path": [round(tx0, 3), round(ty0, 3), round(tx1, 3), round(ty1, 3)],
                }
            )
        candidates.sort(key=lambda item: tuple(item.get("score") or [999999]))
        debug = {
            "self": my_scene_id,
            "self_source": self.my_scene_source or "none",
            "self_path": [round(sx0, 3), round(sy0, 3), round(sx1, 3), round(sy1, 3)],
            "step_ms": step_ms,
            "axis_mode": axis_mode,
            "movement": self.movement_debug_snapshot(),
            "near_skips": near_skips,
            "stale_skips": stale_skips,
            "candidates": candidates[:6],
        }
        return candidates[: max(self._proxy_contact_max_targets(), self._packet_brain_max_targets())], debug

    def _append_proxy_move_brain_after_move(self, frame: bytes, out: bytearray) -> None:
        if not self.config.proxy_contact_counter:
            return
        now_ms = int(time.time() * 1000)
        if now_ms < self.proxy_contact_inhibit_until_ms:
            self.proxy_contact_counter_skips += 1
            self.proxy_contact_counter_last_debug = {"skip": "post_resolve_inhibit", "inhibit_ms": self.proxy_contact_inhibit_until_ms - now_ms, "source": "move_brain"}
            return
        busy_block = self._proxy_auto_punch_block(now_ms, include_recent_busy=True)
        if busy_block is not None:
            self.proxy_contact_counter_skips += 1
            self.proxy_contact_counter_last_debug = {"source": "move_brain", **busy_block}
            return
        candidates, debug = self._proxy_move_brain_candidates(frame, now_ms)
        if not candidates:
            self.proxy_contact_counter_skips += 1
            self.proxy_contact_counter_last_debug = {"skip": "move_brain_no_target", **debug}
            return
        selected_candidates = self._compatible_contact_candidates(candidates, 1)
        selected_targets: List[str] = []
        for item in selected_candidates:
            target_id = normalize_target_id(item.get("id"))
            if target_id is not None and target_id not in selected_targets:
                selected_targets.append(target_id)
        if not selected_targets:
            self.proxy_contact_counter_skips += 1
            self.proxy_contact_counter_last_debug = {"skip": "move_brain_invalid_targets", **debug}
            return
        try:
            frames_by_target = {target_id: build_punch_frame(target_id) for target_id in selected_targets}
        except ValueError:
            self.proxy_contact_counter_skips += 1
            self.proxy_contact_counter_last_debug = {"skip": "move_brain_frame_error", "targets": selected_targets, **debug}
            return
        best = selected_candidates[0]
        best_contact = best.get("contact") or {}
        fire_delay_ms = max(0, parse_int_field(best_contact.get("fire_delay_ms"), 0) or 0)
        burst_id = self.proxy_contact_burst_id
        copies = sanitize_proxy_contact_copies(self.config.proxy_contact_copies)
        per_batch_copies = copies * len(selected_targets)
        scheduled_batches = 0
        if fire_delay_ms <= 0:
            for _copy_idx in range(copies):
                for target_id in selected_targets:
                    out.extend(frames_by_target[target_id])
            scheduled_batches += 1
            self.punches_injected += per_batch_copies
            for copy_idx in range(copies):
                for target_id in selected_targets:
                    self._record_punch_send(
                        target_id=target_id,
                        source="proxy_move_brain",
                        copy_index=copy_idx + 1,
                        copy_total=copies,
                        move_attached=True,
                    )
            self.proxy_contact_inhibit_until_ms = max(
                self.proxy_contact_inhibit_until_ms,
                now_ms + PROXY_AUTO_PUNCH_POST_SEND_INHIBIT_MS,
            )
            self.proxy_contact_scan_scheduled_at_by_key.clear()
            self.proxy_contact_burst_id += 1
        else:
            timer = threading.Timer(
                fire_delay_ms / 1000.0,
                self._send_proxy_contact_batch,
                args=(selected_targets, frames_by_target, copies, fire_delay_ms, 1, 1, "proxy_move_brain", burst_id),
            )
            timer.daemon = True
            timer.start()
            scheduled_batches += 1
        ladder_ms = sanitize_proxy_contact_ladder_ms(self.config.proxy_contact_ladder_ms)
        ladder_steps = sanitize_proxy_contact_ladder_steps(self.config.proxy_contact_ladder_steps)
        if ladder_ms > 0 and ladder_steps > 1:
            for idx in range(1, ladder_steps):
                delay_ms = fire_delay_ms + int(round(float(idx) * float(ladder_ms) / float(max(1, ladder_steps - 1))))
                timer = threading.Timer(
                    delay_ms / 1000.0,
                    self._send_proxy_contact_batch,
                    args=(selected_targets, frames_by_target, copies, delay_ms, idx + 1, ladder_steps, "proxy_move_brain", burst_id),
                )
                timer.daemon = True
                timer.start()
                scheduled_batches += 1
        self.proxy_contact_counter_fires += 1
        self.proxy_contact_counter_last_fire_at_ms = now_ms
        self.proxy_contact_counter_last_target = str(best.get("id") or "")
        self.proxy_contact_counter_last_reason = (
            f"move_brain target={best.get('id')} fire={fire_delay_ms}ms contact={best_contact.get('contact_eta_ms', best_contact.get('contact_in_ms'))}ms "
            f"axis={best_contact.get('axis')} fanout={len(selected_targets)} ladder={ladder_ms}x{scheduled_batches}"
        )
        self.proxy_contact_counter_last_debug = {
            "target_id": str(best.get("id") or ""),
            "targets": selected_targets,
            "fanout": len(selected_targets),
            "copies": copies,
            "fire_delay_ms": fire_delay_ms,
            "contact_eta_ms": best_contact.get("contact_eta_ms", best_contact.get("contact_in_ms")),
            "ladder_ms": ladder_ms,
            "ladder_steps": scheduled_batches,
            "source": "proxy_move_brain",
            **debug,
        }
        self.registry.add_event(
            {
                "type": "PROXY_MOVE_BRAIN_FIRE",
                "session_id": self.session_id,
                "target_id": str(best.get("id") or ""),
                "targets": selected_targets,
                "reason": self.proxy_contact_counter_last_reason,
                "copies": copies,
                "total_copies": per_batch_copies * scheduled_batches,
                "fire_delay_ms": fire_delay_ms,
                "contact_eta_ms": best_contact.get("contact_eta_ms", best_contact.get("contact_in_ms")),
                "ladder_ms": ladder_ms,
                "ladder_steps": scheduled_batches,
                "candidates": candidates[:6],
            }
        )

    def _append_packet_brain_after_up_move(self, frame: bytes, out: bytearray) -> None:
        if not self.config.packet_brain:
            return
        now_ms = int(time.time() * 1000)
        try:
            candidates, debug = self._proxy_move_brain_candidates(frame, now_ms)
        except Exception as exc:
            self._packet_brain_note_skip("up182_pick_error", {"error": str(exc)})
            return
        self._packet_brain_fire_candidates(
            now_ms,
            "up182",
            candidates,
            debug,
            PACKET_BRAIN_UP_MOVE_OFFSETS_MS,
            out,
        )

    def transform_upstream_crypto(self, data: bytes) -> bytes:
        """Decrypt, inspect and re-encrypt upstream data without changing frame order."""
        decrypted = self.client_decrypt.crypt(data) if self.client_decrypt else data
        self.up_plain_buffer.extend(decrypted)
        prefix, frames, remainder = split_complete_frames(self.up_plain_buffer)
        self.up_plain_buffer = remainder
        out = bytearray(prefix)
        for frame in frames:
            is_punch, target = is_punch_frame(frame)
            self.log_upstream_frame(frame, is_punch, target)
            if is_punch:
                self.punches_seen += 1
                self.flood_target = target
                self.flood_frame = frame
                if self.config.flood and not self.flood_active:
                    self._start_flood()
                if self.config.multiply > 1:
                    copies = sanitize_multiply(self.config.multiply)
                    for idx in range(copies):
                        out.extend(frame)
                        source = "client" if idx == 0 else "multiply"
                        self._record_punch_send(
                            target_id=target,
                            source=source,
                            copy_index=idx + 1,
                            copy_total=copies,
                            move_attached=False,
                        )
                    self.punches_injected += copies - 1
                    if self.config.verbose:
                        self.log(f"inject punch target={target} total={copies}x")
                else:
                    out.extend(frame)
                    self._record_punch_send(
                        target_id=target,
                        source="client",
                        copy_index=1,
                        copy_total=1,
                        move_attached=False,
                    )
                self._append_echo_punch_after_client_punch(target, frame, out)
            else:
                opcode = extract_opcode(frame)
                if opcode == (182,):
                    self.last_move_frame = bytes(frame)
                    self._record_move_send(frame)
                out.extend(frame)
                if opcode == (182,):
                    self._append_packet_brain_after_up_move(frame, out)
                    self._append_proxy_move_brain_after_move(frame, out)
                    self._append_move_punch_after_move(out)
        enc = self.server_encrypt
        if enc:
            # Preserve original upstream order so movement stays before its timed punch.
            return enc.crypt(bytes(out)) if out else b""
        return bytes(out)

    def handle_upstream(self, data: bytes) -> None:
        self.up_bytes += len(data)
        if self.config.mode == "relay":
            self.remote_sock.sendall(data)
            return
        if not self.crypto_active:
            if self.config.swf_key:
                self.forward_plain_swf_key(data, downstream=False)
                return
            self.forward_plain_and_sniff(data, downstream=False)
            return
        with self.upstream_lock:
            payload = self.transform_upstream_crypto(data)
            if payload:
                self.remote_sock.sendall(payload)

    def handle_downstream(self, data: bytes) -> None:
        self.down_bytes += len(data)
        if self.config.mode == "relay":
            self.client_sock.sendall(data)
            return
        if not self.crypto_active:
            if self.config.swf_key:
                self.forward_plain_swf_key(data, downstream=True)
                return
            self.forward_plain_and_sniff(data, downstream=True)
            return
        if self.server_decrypt:
            decrypted = self.server_decrypt.crypt(data)
            self.down_plain_buffer.extend(decrypted)
            prefix, frames, remainder = split_complete_frames(self.down_plain_buffer)
            self.down_plain_buffer = remainder
            # Build plaintext to send to client: prefix + frames + any pending injections
            plaintext_out = bytearray(prefix)
            for frame in frames:
                self.track_ring_ids_from_frame(frame)
                self._send_step_punch_from_step(frame)
                if self.config.verbose:
                    self.log_downstream_frame(frame)
                plaintext_out.extend(frame)
            # Splice in any pending downstream injections
            with self.downstream_lock:
                if self._pending_downstream:
                    self.log(f"INJECT_DOWN splicing {len(self._pending_downstream)} bytes")
                    plaintext_out.extend(self._pending_downstream)
                    self._pending_downstream = bytearray()
            # Re-encrypt for client
            encrypted = self.client_encrypt.crypt(bytes(plaintext_out))
            self.client_sock.sendall(encrypted)
        else:
            self.client_sock.sendall(data)

    def run(self) -> None:
        self.registry.add(self)
        try:
            self.connect_remote()
            while True:
                readable, _, exceptional = select.select([self.client_sock, self.remote_sock], [], [self.client_sock, self.remote_sock], 0.5)
                if exceptional:
                    break
                if not readable:
                    continue
                if self.client_sock in readable:
                    data = self.client_sock.recv(BUFFER_SIZE)
                    if not data:
                        break
                    self.handle_upstream(data)
                if self.remote_sock in readable:
                    data = self.remote_sock.recv(BUFFER_SIZE)
                    if not data:
                        break
                    self.handle_downstream(data)
                self.maybe_log_stats()
        except Exception as exc:
            self.last_error = str(exc)
            self.log(f"error {exc}")
            if self.config.verbose:
                traceback.print_exc()
        finally:
            self.close()
            self.registry.remove(self.session_id)
            self.log("session ended")


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="BoomBang definitive proxy")
    parser.add_argument("--mode", choices=("relay", "mitm"), default=env_str("BB_PROXY_MODE", "relay"))
    parser.add_argument("--listen-host", default=env_str("BB_PROXY_LISTEN_HOST", LISTEN_HOST))
    parser.add_argument("--listen-port", type=int, default=env_int("BB_PROXY_LISTEN_PORT", LISTEN_PORT))
    parser.add_argument("--remote-host", default=env_str("BB_PROXY_REMOTE_HOST", REMOTE_HOST))
    parser.add_argument("--remote-port", type=int, default=env_int("BB_PROXY_REMOTE_PORT", REMOTE_PORT))
    parser.add_argument("--http-host", default=env_str("BB_PROXY_HTTP_HOST", HTTP_HOST))
    parser.add_argument("--http-port", type=int, default=env_int("BB_PROXY_HTTP_PORT", HTTP_PORT))
    parser.add_argument("--multiply", type=int, default=env_int("BB_PROXY_MULTIPLY", 1))
    parser.add_argument("--flood", action="store_true", default=env_str("BB_PROXY_FLOOD", "0") == "1")
    parser.add_argument("--flood-interval", type=float, default=float(env_str("BB_PROXY_FLOOD_INTERVAL", "0.0")))
    parser.add_argument("--move-punch", action="store_true", default=env_str("BB_PROXY_MOVE_PUNCH", "0") == "1")
    parser.add_argument("--move-punch-copies", type=int, default=env_int("BB_PROXY_MOVE_PUNCH_COPIES", 1))
    parser.add_argument("--move-punch-delay-ms", type=int, default=env_int("BB_PROXY_MOVE_PUNCH_DELAY_MS", 0))
    parser.add_argument("--move-punch-spacing-ms", type=int, default=env_int("BB_PROXY_MOVE_PUNCH_SPACING_MS", 0))
    parser.add_argument("--move-punch-target", default=env_str("BB_PROXY_MOVE_PUNCH_TARGET", ""))
    parser.add_argument("--step-punch", action="store_true", default=env_str("BB_PROXY_STEP_PUNCH", "0") == "1")
    parser.add_argument("--echo-punch", action="store_true", default=env_str("BB_PROXY_ECHO_PUNCH", "0") == "1")
    parser.add_argument("--echo-punch-copies", type=int, default=env_int("BB_PROXY_ECHO_PUNCH_COPIES", 0))
    parser.add_argument("--echo-punch-delay-ms", type=int, default=env_int("BB_PROXY_ECHO_PUNCH_DELAY_MS", 0))
    parser.add_argument("--echo-punch-spacing-ms", type=int, default=env_int("BB_PROXY_ECHO_PUNCH_SPACING_MS", 0))
    parser.add_argument("--proxy-contact-counter", action="store_true", default=env_str("BB_PROXY_CONTACT_COUNTER", "0") == "1")
    parser.add_argument("--proxy-contact-copies", type=int, default=env_int("BB_PROXY_CONTACT_COPIES", 1))
    parser.add_argument("--proxy-contact-targets", type=int, default=env_int("BB_PROXY_CONTACT_TARGETS", 1))
    parser.add_argument("--proxy-contact-min-gap-ms", type=int, default=env_int("BB_PROXY_CONTACT_MIN_GAP_MS", 0))
    parser.add_argument("--proxy-contact-ladder-ms", type=int, default=env_int("BB_PROXY_CONTACT_LADDER_MS", 0))
    parser.add_argument("--proxy-contact-ladder-steps", type=int, default=env_int("BB_PROXY_CONTACT_LADDER_STEPS", 1))
    parser.add_argument("--proxy-contact-axis", default=env_str("BB_PROXY_CONTACT_AXIS", "both"))
    parser.add_argument("--packet-brain", action="store_true", default=env_str("BB_PROXY_PACKET_BRAIN", "0") == "1")
    parser.add_argument("--packet-brain-copies", type=int, default=env_int("BB_PROXY_PACKET_BRAIN_COPIES", 1))
    parser.add_argument("--packet-brain-targets", type=int, default=env_int("BB_PROXY_PACKET_BRAIN_TARGETS", 2))
    parser.add_argument("--packet-brain-ladder-ms", type=int, default=env_int("BB_PROXY_PACKET_BRAIN_LADDER_MS", 0))
    parser.add_argument("--packet-brain-ladder-steps", type=int, default=env_int("BB_PROXY_PACKET_BRAIN_LADDER_STEPS", 1))
    parser.add_argument("--swf-key", action="store_true", default=env_str("BB_PROXY_SWF_KEY", "1") != "0")
    parser.add_argument("--no-swf-key", action="store_false", dest="swf_key")
    parser.add_argument("--detailed-events", action="store_true", default=env_str("BB_PROXY_DETAILED_EVENTS", "0") == "1")
    parser.add_argument("--live-historical", action="store_true", default=env_str("BB_PROXY_LIVE_HISTORICAL", "0") == "1")
    parser.add_argument("--verbose", action="store_true", default=env_str("BB_PROXY_VERBOSE", "0") == "1")
    parser.add_argument("--log-dir", default=env_str("BB_PROXY_LOG_DIR", "logs"))
    return parser


def make_handler(registry: ProxyRegistry):
    class ControlHandler(BaseHTTPRequestHandler):
        def _parse_request(self):
            from urllib.parse import parse_qs, urlparse

            parsed = urlparse(self.path)
            return parsed, parse_qs(parsed.query)

        def _wants_json(self, qs: dict) -> bool:
            return (qs.get("format", [""])[0] or "").strip().lower() == "json"

        def _client_gone(self, error: BaseException) -> bool:
            return isinstance(error, (BrokenPipeError, ConnectionAbortedError, ConnectionResetError)) or getattr(error, "winerror", None) in (10053, 10054) or getattr(error, "errno", None) in (32, 54, 104)

        def _write_response(self, code: int, content_type: str, payload: bytes) -> None:
            try:
                self.send_response(code)
                self.send_header("Content-Type", content_type)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except OSError as error:
                if self._client_gone(error):
                    return
                raise

        def _html_response(self, body: str) -> None:
            payload = body.encode("utf-8")
            self._write_response(200, "text/html; charset=utf-8", payload)

        def _xml_response(self, body: str) -> None:
            payload = body.encode("utf-8")
            self._write_response(200, "text/x-cross-domain-policy; charset=utf-8", payload)

        @staticmethod
        def _fmt_value(value: object) -> str:
            if value in (None, ""):
                return "-"
            return str(value)

        def _render_page(self, title: str, subtitle: str, content: str, payload_var: str, payload: dict) -> str:
            payload_json = json.dumps(payload, ensure_ascii=False)
            return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{html.escape(title)}</title>
  <style>
    :root {{
      color-scheme: dark;
      --bg: #111318;
      --panel: #181b22;
      --panel2: #1f2430;
      --border: #2a3140;
      --text: #eef2ff;
      --muted: #a7b0c3;
      --accent: #7dd3fc;
      --good: #86efac;
    }}
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; font: 14px/1.45 "Segoe UI", system-ui, sans-serif; background: linear-gradient(180deg,#0d1016 0%,#151923 100%); color: var(--text); }}
    .wrap {{ max-width: 1400px; margin: 0 auto; padding: 18px; }}
    .top {{ display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; margin-bottom: 18px; }}
    .title h1 {{ margin: 0 0 4px; font-size: 26px; }}
    .title p {{ margin: 0; color: var(--muted); }}
    .actions {{ display: flex; flex-wrap: wrap; gap: 8px; }}
    button, a.btn {{ appearance: none; border: 1px solid var(--border); background: var(--panel2); color: var(--text); border-radius: 8px; padding: 8px 12px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; }}
    button:hover, a.btn:hover {{ border-color: var(--accent); }}
    .grid {{ display: grid; gap: 14px; }}
    .cards {{ grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }}
    .card, .panel {{ background: rgba(24,27,34,.96); border: 1px solid var(--border); border-radius: 12px; }}
    .card {{ padding: 12px 14px; }}
    .panel {{ padding: 14px; }}
    .label {{ color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 6px; }}
    .value {{ font-size: 22px; font-weight: 700; }}
    .panel h2 {{ margin: 0 0 12px; font-size: 16px; }}
    .table-wrap {{ overflow: auto; max-height: 70vh; border-radius: 10px; }}
    table {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
    th, td {{ padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }}
    th {{ color: var(--muted); font-weight: 600; position: sticky; top: 0; background: rgba(24,27,34,.98); }}
    pre {{ margin: 0; background: #0e1117; border: 1px solid var(--border); border-radius: 10px; padding: 10px; white-space: pre-wrap; word-break: break-word; font: 12px Consolas, monospace; }}
    .pill {{ display: inline-block; border-radius: 999px; padding: 2px 8px; border: 1px solid var(--border); color: var(--muted); }}
    .self td {{ color: var(--good); font-weight: 700; }}
    .split {{ display: grid; grid-template-columns: 1.2fr .8fr; gap: 14px; }}
    .muted {{ color: var(--muted); }}
    @media (max-width: 1000px) {{
      .top {{ flex-direction: column; }}
      .split {{ grid-template-columns: 1fr; }}
    }}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="title">
        <h1>{html.escape(title)}</h1>
        <p>{html.escape(subtitle)}</p>
      </div>
      <div class="actions">
        <a class="btn" href="/debug">Debug</a>
        <a class="btn" href="/roster">Roster</a>
        <a class="btn" href="?format=json">JSON</a>
        <button onclick="copyJson()">Copy JSON</button>
      </div>
    </div>
    {content}
  </div>
  <script>
    const {payload_var} = {payload_json};
    async function copyJson() {{
      await navigator.clipboard.writeText(JSON.stringify({payload_var}, null, 2));
    }}
    async function copyText(text) {{
      await navigator.clipboard.writeText(text);
    }}
  </script>
</body>
</html>"""

        def _render_debug_html(self, payload: dict) -> str:
            summary = payload.get("summary", {})
            config = payload.get("config", {})
            sessions = payload.get("sessions", [])
            cards = [
                ("Sessions", summary.get("active_sessions")),
                ("Crypto", summary.get("crypto_sessions")),
                ("211 Seen", summary.get("punch211_seen")),
                ("211 Sent", summary.get("punch211_total_sent")),
                ("Correlated", summary.get("punch211_correlated_resolves")),
                ("Self ATK", summary.get("punch211_self_atk_matches")),
                ("Self DEF", summary.get("punch211_self_def_matches")),
                ("Target Miss", summary.get("punch211_self_target_miss_matches")),
                ("Proxy Contact", summary.get("proxy_contact_counter_fires")),
                ("Match Rate", summary.get("punch211_match_rate")),
            ]
            card_html = "".join(
                f"<div class='card'><div class='label'>{html.escape(label)}</div><div class='value'>{html.escape(self._fmt_value(value))}</div></div>"
                for label, value in cards
            )
            blocks = []
            for item in sessions:
                session = item.get("session", {})
                punch = item.get("punch211", {})
                timing = item.get("timing_analysis", {})
                rec = timing.get("recommendation", {})
                recent_rows = []
                for match in punch.get("recent_matches", [])[:10]:
                    recent_rows.append(
                        "<tr>"
                        f"<td>{html.escape(self._fmt_value(match.get('seq')))}</td>"
                        f"<td>{html.escape(self._fmt_value(match.get('role')))}</td>"
                        f"<td>{html.escape(self._fmt_value(match.get('target_id')))}</td>"
                        f"<td>{html.escape(self._fmt_value(match.get('target_correct')))}</td>"
                        f"<td>{html.escape(self._fmt_value(match.get('latency_ms')))}</td>"
                        f"<td>{html.escape(self._fmt_value(match.get('late')))}</td>"
                        "</tr>"
                    )
                recent_html = "".join(recent_rows) or "<tr><td colspan='6' class='muted'>No matches</td></tr>"
                preferred = rec.get("preferred_match_after_last_step_ms")
                preferred_text = "-"
                if preferred:
                    preferred_text = f"{preferred.get('from')} .. {preferred.get('to')} (center {preferred.get('center')})"
                historical = timing.get("historical", {}) or {}
                hist_rec = historical.get("recommendation", {}) or {}
                hist_pref = hist_rec.get("preferred_match_after_last_step_ms")
                hist_pref_text = "-"
                if hist_pref:
                    hist_pref_text = f"{hist_pref.get('from')} .. {hist_pref.get('to')} (center {hist_pref.get('center')})"
                cross_rows = []
                by_cross_type = timing.get("by_cross_type", {}) or {}
                for cross_type, cross_item in sorted(by_cross_type.items()):
                    cross_rec = cross_item.get("recommendation", {}) or {}
                    cross_pref = cross_rec.get("preferred_match_after_last_step_ms")
                    cross_pref_text = "-"
                    if cross_pref:
                        cross_pref_text = f"{cross_pref.get('from')} .. {cross_pref.get('to')} (c {cross_pref.get('center')})"
                    cross_rows.append(
                        "<tr>"
                        f"<td>{html.escape(self._fmt_value(cross_type))}</td>"
                        f"<td>{html.escape(self._fmt_value(cross_item.get('samples')))}</td>"
                        f"<td>{html.escape(self._fmt_value((cross_item.get('self_atk') or {}).get('target_correct_samples')))}</td>"
                        f"<td>{html.escape(self._fmt_value((cross_item.get('self_def') or {}).get('target_correct_samples')))}</td>"
                        f"<td>{html.escape(self._fmt_value((cross_rec or {}).get('status')))}</td>"
                        f"<td>{html.escape(cross_pref_text)}</td>"
                        "</tr>"
                    )
                cross_type_html = "".join(cross_rows) or "<tr><td colspan='6' class='muted'>No cross-type timing samples</td></tr>"
                hist_cross_rows = []
                hist_by_cross_type = historical.get("by_cross_type", {}) or {}
                for cross_type, cross_item in sorted(hist_by_cross_type.items()):
                    cross_rec = cross_item.get("recommendation", {}) or {}
                    cross_pref = cross_rec.get("preferred_match_after_last_step_ms")
                    cross_pref_text = "-"
                    if cross_pref:
                        cross_pref_text = f"{cross_pref.get('from')} .. {cross_pref.get('to')} (c {cross_pref.get('center')})"
                    hist_cross_rows.append(
                        "<tr>"
                        f"<td>{html.escape(self._fmt_value(cross_type))}</td>"
                        f"<td>{html.escape(self._fmt_value(cross_item.get('samples')))}</td>"
                        f"<td>{html.escape(self._fmt_value((cross_item.get('self_atk') or {}).get('target_correct_samples')))}</td>"
                        f"<td>{html.escape(self._fmt_value((cross_item.get('self_def') or {}).get('target_correct_samples')))}</td>"
                        f"<td>{html.escape(self._fmt_value((cross_rec or {}).get('status')))}</td>"
                        f"<td>{html.escape(cross_pref_text)}</td>"
                        "</tr>"
                    )
                hist_cross_type_html = "".join(hist_cross_rows) or "<tr><td colspan='6' class='muted'>No historical cross-type timing samples</td></tr>"
                blocks.append(
                    "<div class='panel'>"
                    f"<h2>Session {html.escape(self._fmt_value(session.get('id')))} <span class='pill'>scene {html.escape(self._fmt_value(session.get('my_scene_id')))}</span> <span class='pill'>account {html.escape(self._fmt_value(session.get('my_account_id')))}</span></h2>"
                    "<div class='split'>"
                    "<div>"
                    "<div class='grid cards'>"
                    f"<div class='card'><div class='label'>Self Target Punches</div><div class='value'>{html.escape(self._fmt_value(punch.get('self_target_punches')))}</div></div>"
                    f"<div class='card'><div class='label'>Pending</div><div class='value'>{html.escape(self._fmt_value(punch.get('pending')))}</div></div>"
                    f"<div class='card'><div class='label'>Avg Latency</div><div class='value'>{html.escape(self._fmt_value(punch.get('avg_match_latency_ms')))}</div></div>"
                    f"<div class='card'><div class='label'>Log Dir</div><div class='value'>{html.escape(self._fmt_value(config.get('log_dir')))}</div></div>"
                    "</div>"
                    "<div class='panel' style='margin-top:12px'>"
                    "<h2>Recent Matches</h2>"
                    "<div class='table-wrap'><table><thead><tr><th>Seq</th><th>Role</th><th>Target</th><th>Correct</th><th>Latency</th><th>Late</th></tr></thead>"
                    f"<tbody>{recent_html}</tbody></table></div>"
                    "</div>"
                    "</div>"
                    "<div>"
                    "<div class='panel'>"
                    "<h2>Timing Recommendation</h2>"
                    f"<p><strong>Status:</strong> {html.escape(self._fmt_value(rec.get('status')))}</p>"
                    f"<p><strong>Reason:</strong> {html.escape(self._fmt_value(rec.get('reason')))}</p>"
                    f"<p><strong>Preferred Window:</strong> {html.escape(preferred_text)}</p>"
                    "</div>"
                    "<div class='panel' style='margin-top:12px'>"
                    "<h2>Historical Timing</h2>"
                    f"<p><strong>Status:</strong> {html.escape(self._fmt_value(hist_rec.get('status')))}</p>"
                    f"<p><strong>Reason:</strong> {html.escape(self._fmt_value(hist_rec.get('reason')))}</p>"
                    f"<p><strong>Preferred Window:</strong> {html.escape(hist_pref_text)}</p>"
                    f"<p><strong>Runs / Samples:</strong> {html.escape(self._fmt_value(historical.get('runs')))} / {html.escape(self._fmt_value(historical.get('event_count')))}</p>"
                    "</div>"
                    "<div class='panel' style='margin-top:12px'>"
                    "<h2>Cross Type Timing</h2>"
                    "<div class='table-wrap'><table><thead><tr><th>Type</th><th>Samples</th><th>ATK Clean</th><th>DEF Clean</th><th>Status</th><th>Window</th></tr></thead>"
                    f"<tbody>{cross_type_html}</tbody></table></div>"
                    "</div>"
                    "<div class='panel' style='margin-top:12px'>"
                    "<h2>Historical Cross Type Timing</h2>"
                    "<div class='table-wrap'><table><thead><tr><th>Type</th><th>Samples</th><th>ATK Clean</th><th>DEF Clean</th><th>Status</th><th>Window</th></tr></thead>"
                    f"<tbody>{hist_cross_type_html}</tbody></table></div>"
                    "</div>"
                    "<div class='panel' style='margin-top:12px'>"
                    "<h2>Cross Taxonomy</h2>"
                    f"<pre>{html.escape(json.dumps(item.get('cross_taxonomy', {}), ensure_ascii=False, indent=2))}</pre>"
                    "</div>"
                    "</div>"
                    "</div>"
                    "</div>"
                )
            content = "<div class='grid cards'>" + card_html + "</div>" + "".join(blocks or ["<div class='panel'><h2>No active sessions</h2></div>"])
            return self._render_page("Punch Proxy Debug", "Resumen corto y matches recientes.", content, "debugPayload", payload)

        def _render_roster_html(self, payload: dict) -> str:
            sessions = payload.get("sessions", [])
            blocks = []
            for item in sessions:
                session = item.get("session", {})
                roster = item.get("roster", {})
                players = roster.get("players", [])
                combatants = roster.get("combatants", [])
                combat_rows = []
                for player in combatants:
                    row_class = " class='self'" if player.get("is_self") else ""
                    combat_rows.append(
                        f"<tr{row_class}>"
                        f"<td>{html.escape(self._fmt_value(player.get('scene_id')))}</td>"
                        f"<td>{html.escape(self._fmt_value(player.get('account_id')))}</td>"
                        f"<td>{html.escape(self._fmt_value(player.get('name')))}</td>"
                        f"<td>{html.escape(self._fmt_value(player.get('skin_id')))}</td>"
                        f"<td>{html.escape(self._fmt_value(player.get('x')))}</td>"
                        f"<td>{html.escape(self._fmt_value(player.get('y')))}</td>"
                        f"<td>{html.escape(self._fmt_value(player.get('orientation')))}</td>"
                        f"<td>{html.escape(self._fmt_value(player.get('state_code')))}</td>"
                        f"<td>{html.escape(self._fmt_value(player.get('active_reason')))}</td>"
                        "</tr>"
                    )
                combat_html = "".join(combat_rows) or "<tr><td colspan='9' class='muted'>No active combatants</td></tr>"
                rows = []
                for player in players:
                    row_class = " class='self'" if player.get("is_self") else ""
                    rows.append(
                        f"<tr{row_class}>"
                        f"<td>{html.escape(self._fmt_value(player.get('scene_id')))}</td>"
                        f"<td>{html.escape(self._fmt_value(player.get('account_id')))}</td>"
                        f"<td>{html.escape(self._fmt_value(player.get('name')))}</td>"
                        f"<td>{html.escape(self._fmt_value(player.get('skin_id')))}</td>"
                        f"<td>{html.escape(self._fmt_value(player.get('x')))}</td>"
                        f"<td>{html.escape(self._fmt_value(player.get('y')))}</td>"
                        f"<td>{html.escape(self._fmt_value(player.get('orientation')))}</td>"
                        f"<td>{html.escape(self._fmt_value(player.get('state_code')))}</td>"
                        f"<td>{html.escape(self._fmt_value(player.get('last_move_hms')))}</td>"
                        f"<td>{html.escape(self._fmt_value(player.get('last_move_ago_ms')))}</td>"
                        "</tr>"
                    )
                rows_html = "".join(rows) or "<tr><td colspan='10' class='muted'>No roster data</td></tr>"
                blocks.append(
                    "<div class='panel'>"
                    f"<h2>Session {html.escape(self._fmt_value(session.get('id')))} <span class='pill'>self scene {html.escape(self._fmt_value(session.get('my_scene_id')))}</span> <span class='pill'>players {html.escape(self._fmt_value(roster.get('count')))}</span> <span class='pill'>combatants {html.escape(self._fmt_value(len(combatants)))}</span></h2>"
                    "<div class='actions' style='margin-bottom:12px'>"
                    "<button onclick='copyRosterTsv()'>Copy TSV</button>"
                    "<button onclick='copyNames()'>Copy Names</button>"
                    "</div>"
                    "<h2>Active Combatants</h2>"
                    "<div class='table-wrap' style='margin-bottom:12px'><table><thead><tr><th>Scene</th><th>UserID</th><th>Name</th><th>Skin</th><th>X</th><th>Y</th><th>Orient</th><th>State</th><th>Why</th></tr></thead>"
                    f"<tbody>{combat_html}</tbody></table></div>"
                    "<h2>Full Scene Roster</h2>"
                    "<div class='table-wrap'><table><thead><tr><th>Scene</th><th>UserID</th><th>Name</th><th>Skin</th><th>X</th><th>Y</th><th>Orient</th><th>State</th><th>LastMove</th><th>Ago(ms)</th></tr></thead>"
                    f"<tbody>{rows_html}</tbody></table></div>"
                    "</div>"
                )
            content = "".join(blocks or ["<div class='panel'><h2>No active sessions</h2></div>"])
            page = self._render_page("Punch Proxy Roster", "Roster de la escena actual, armado desde packets descifrados.", content, "rosterPayload", payload)
            extra = """
<script>
  function rosterPlayers() {
    const sessions = rosterPayload.sessions || [];
    if (!sessions.length) return [];
    return (sessions[0].roster && sessions[0].roster.players) || [];
  }
  async function copyRosterTsv() {
    const rows = rosterPlayers();
    const head = ["scene_id","account_id","name","skin_id","x","y","orientation","state_code","last_move_hms","last_move_ago_ms"];
    const lines = [head.join("\\t")];
    for (const row of rows) {
      lines.push(head.map((key) => row[key] == null ? "" : String(row[key])).join("\\t"));
    }
    await copyText(lines.join("\\n"));
  }
  async function copyNames() {
    const names = rosterPlayers().map((row) => row.name || "").filter(Boolean).join("\\n");
    await copyText(names);
  }
</script>
</body>
</html>"""
            return page.replace("</body>\n</html>", extra)

        def do_GET(self) -> None:
            parsed, qs = self._parse_request()
            if parsed.path.startswith("/crossdomain.xml"):
                return self._xml_response('<?xml version="1.0"?><cross-domain-policy><allow-access-from domain="*" to-ports="*" secure="false" /></cross-domain-policy>')
            if parsed.path.startswith("/proxy_remote"):
                return self._handle_proxy_remote(qs)
            if parsed.path.startswith("/swf_rc4_key"):
                return self._handle_swf_rc4_key(qs)
            if parsed.path.startswith("/events"):
                return self._handle_get_events()
            if parsed.path.startswith("/roster"):
                return self._handle_get_roster()
            if parsed.path.startswith("/debug"):
                return self._handle_get_debug()
            payload = registry.snapshots()
            self._json_response(200, payload)

        def _handle_proxy_remote(self, qs: dict) -> None:
            host = (qs.get("host", [""])[0] or "").strip()
            raw_port = (qs.get("port", [""])[0] or "").strip()
            try:
                port = int(raw_port)
            except ValueError:
                port = 0
            ok = registry.apply_swf_remote(host, port)
            self._json_response(
                200 if ok else 400,
                {
                    "ok": ok,
                    "remote": f"{registry.config.remote_host}:{registry.config.remote_port}",
                    "swf_remote_report": registry.swf_remote_report,
                },
            )

        def _handle_swf_rc4_key(self, qs: dict) -> None:
            key_hex = (qs.get("key", [""])[0] or "").strip()
            applied = registry.apply_swf_rc4_key(key_hex)
            self._json_response(200 if applied > 0 else 202, {"ok": applied > 0, "applied": applied})

        def _handle_get_events(self) -> None:
            """GET /events?since_ms=<timestamp> — return recent downstream events."""
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            since_ms = int(qs.get("since_ms", ["0"])[0])
            events = registry.get_events(since_ms)
            self._json_response(200, {"events": events, "count": len(events)})

        def _handle_get_debug(self) -> None:
            _parsed, qs = self._parse_request()
            payload = registry.debug_payload()
            if self._wants_json(qs):
                self._json_response(200, payload)
                return
            self._html_response(self._render_debug_html(payload))

        def _handle_get_roster(self) -> None:
            _parsed, qs = self._parse_request()
            payload = registry.roster_payload()
            if self._wants_json(qs):
                self._json_response(200, payload)
                return
            self._html_response(self._render_roster_html(payload))

        def do_POST(self) -> None:
            size = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(size) if size > 0 else b"{}"
            data = json.loads(body.decode("utf-8"))

            # --- PEN-TEST: inject arbitrary frame upstream ---
            if self.path == "/inject":
                return self._handle_inject(data)
            if self.path == "/inject_downstream":
                return self._handle_inject_downstream(data)

            if "multiply" in data:
                registry.config.multiply = sanitize_multiply(int(data["multiply"]))
            if "mode" in data:
                mode = str(data["mode"]).strip().lower()
                if mode in ("relay", "mitm"):
                    registry.config.mode = mode
            if "remote_host" in data:
                remote_host = str(data["remote_host"]).strip()
                if remote_host and remote_host not in ("127.0.0.1", "localhost"):
                    registry.config.remote_host = remote_host
            if "remote_port" in data:
                try:
                    remote_port = int(data["remote_port"])
                except (TypeError, ValueError):
                    remote_port = registry.config.remote_port
                if 0 < remote_port < 65536:
                    registry.config.remote_port = remote_port
            if "flood" in data:
                registry.config.flood = parse_bool(data["flood"])
                if not registry.config.flood:
                    with registry.lock:
                        for s in registry.sessions.values():
                            s._stop_flood()
            if "flood_interval" in data:
                registry.config.flood_interval = max(0.0, float(data["flood_interval"]))
            if "move_punch" in data:
                registry.config.move_punch = parse_bool(data["move_punch"])
            if "move_punch_copies" in data:
                registry.config.move_punch_copies = sanitize_multiply(int(data["move_punch_copies"]))
            if "move_punch_delay_ms" in data:
                registry.config.move_punch_delay_ms = sanitize_delay_ms(data["move_punch_delay_ms"])
            if "move_punch_spacing_ms" in data:
                registry.config.move_punch_spacing_ms = sanitize_delay_ms(data["move_punch_spacing_ms"])
            if "move_punch_target" in data:
                registry.config.move_punch_target = normalize_target_id(data["move_punch_target"]) or ""
            if "step_punch" in data:
                registry.config.step_punch = parse_bool(data["step_punch"])
            if "echo_punch" in data:
                registry.config.echo_punch = parse_bool(data["echo_punch"])
            if "echo_punch_copies" in data:
                registry.config.echo_punch_copies = sanitize_extra_copies(data["echo_punch_copies"])
            if "echo_punch_delay_ms" in data:
                registry.config.echo_punch_delay_ms = sanitize_delay_ms(data["echo_punch_delay_ms"])
            if "echo_punch_spacing_ms" in data:
                registry.config.echo_punch_spacing_ms = sanitize_delay_ms(data["echo_punch_spacing_ms"])
            if "proxy_contact_counter" in data:
                registry.config.proxy_contact_counter = parse_bool(data["proxy_contact_counter"])
            if "proxy_contact_copies" in data:
                registry.config.proxy_contact_copies = sanitize_proxy_contact_copies(data["proxy_contact_copies"])
            if "proxy_contact_targets" in data:
                registry.config.proxy_contact_targets = sanitize_proxy_contact_targets(data["proxy_contact_targets"])
            if "proxy_contact_min_gap_ms" in data:
                registry.config.proxy_contact_min_gap_ms = sanitize_proxy_contact_gap_ms(data["proxy_contact_min_gap_ms"])
            if "proxy_contact_ladder_ms" in data:
                registry.config.proxy_contact_ladder_ms = sanitize_proxy_contact_ladder_ms(data["proxy_contact_ladder_ms"])
            if "proxy_contact_ladder_steps" in data:
                registry.config.proxy_contact_ladder_steps = sanitize_proxy_contact_ladder_steps(data["proxy_contact_ladder_steps"])
            if "proxy_contact_axis" in data:
                registry.config.proxy_contact_axis = sanitize_proxy_contact_axis(data["proxy_contact_axis"])
            if "packet_brain" in data:
                registry.config.packet_brain = parse_bool(data["packet_brain"])
            if "packet_brain_copies" in data:
                registry.config.packet_brain_copies = sanitize_proxy_contact_copies(data["packet_brain_copies"])
            if "packet_brain_targets" in data:
                registry.config.packet_brain_targets = sanitize_proxy_contact_targets(data["packet_brain_targets"])
            if "packet_brain_ladder_ms" in data:
                registry.config.packet_brain_ladder_ms = sanitize_packet_brain_ladder_ms(data["packet_brain_ladder_ms"])
            if "packet_brain_ladder_steps" in data:
                registry.config.packet_brain_ladder_steps = sanitize_packet_brain_ladder_steps(data["packet_brain_ladder_steps"])
            if "self_scene_id" in data:
                registry.apply_hub_self_scene(data["self_scene_id"])
            if "hub_entities" in data:
                registry.apply_hub_entities(data["hub_entities"])
            self._json_response(200, registry.snapshots())

        def _handle_inject(self, data: dict) -> None:
            """Inject arbitrary plaintext frame(s) upstream to the server.
            POST /inject
            {
              "frames": [
                {"opcode": 211, "fields": ["3"]},           // punch target 3
                {"opcode": 182, "fields": ["0102030", "hash"]},  // movement
                {"raw": [177, 211, 179, 178, 51, 179, 178, 176]} // raw bytes
              ],
              "repeat": 1,     // optional: repeat N times
              "delay": 0.0     // optional: delay between repeats (sec)
            }
            """
            frames_spec = data.get("frames", [])
            repeat = max(1, int(data.get("repeat", 1)))
            delay = max(0.0, float(data.get("delay", 0.0)))
            results = []
            session = None
            with registry.lock:
                for s in registry.sessions.values():
                    if s.crypto_active:
                        session = s
                        break
            if session is None:
                self._json_response(400, {"error": "no active crypto session"})
                return
            # Build plaintext frames
            plaintext = bytearray()
            for spec in frames_spec:
                if "raw" in spec:
                    plaintext.extend(bytes(spec["raw"]))
                    results.append({"type": "raw", "len": len(spec["raw"])})
                else:
                    opcode = int(spec["opcode"])
                    fields = [str(f) for f in spec.get("fields", [])]
                    frame = bytearray([FRAME_START])
                    frame.append(opcode)
                    frame.append(SEP)
                    frame.append(HDR_END)
                    for field in fields:
                        for ch in field:
                            frame.append(ord(ch))
                        frame.append(SEP)
                        frame.append(HDR_END)
                    frame.append(FRAME_END)
                    plaintext.extend(frame)
                    results.append({"type": "frame", "opcode": opcode, "fields": fields, "len": len(frame)})
            sent = 0
            try:
                for i in range(repeat):
                    with session.upstream_lock:
                        encrypted = session.server_encrypt.crypt(bytes(plaintext))
                        session.remote_sock.sendall(encrypted)
                    sent += 1
                    if delay > 0 and i < repeat - 1:
                        time.sleep(delay)
            except Exception as e:
                self._json_response(500, {"error": str(e), "sent": sent})
                return
            session.log(f"INJECT sent={sent}x frames={len(frames_spec)} bytes={len(plaintext)}")
            self._json_response(200, {"ok": True, "sent": sent, "frames": results, "plaintext_len": len(plaintext)})

        def _handle_inject_downstream(self, data: dict) -> None:
            """Inject frames DOWNSTREAM to our own client (fake server responses).
            POST /inject_downstream
            {
              "frames": [
                {"opcode": 211, "fields": ["1", "ATTACKER_ID", "100", "100", "0", "DEFENDER_ID", "200", "200"]}
              ]
            }
            """
            frames_spec = data.get("frames", [])
            session = None
            with registry.lock:
                for s in registry.sessions.values():
                    if s.crypto_active:
                        session = s
                        break
            if session is None:
                self._json_response(400, {"error": "no active crypto session"})
                return
            plaintext = bytearray()
            results = []
            for spec in frames_spec:
                if "raw" in spec:
                    plaintext.extend(bytes(spec["raw"]))
                    results.append({"type": "raw", "len": len(spec["raw"])})
                else:
                    opcode = int(spec["opcode"])
                    fields = [str(f) for f in spec.get("fields", [])]
                    frame = bytearray([FRAME_START])
                    frame.append(opcode)
                    frame.append(SEP)
                    frame.append(HDR_END)
                    for field in fields:
                        for ch in field:
                            frame.append(ord(ch))
                        frame.append(SEP)
                        frame.append(HDR_END)
                    frame.append(FRAME_END)
                    plaintext.extend(frame)
                    results.append({"type": "frame", "opcode": opcode, "fields": fields})
            # Encrypt with client_encrypt (we need to add this) and send to client
            # Actually: downstream goes server->client. The client decrypts with the SAME RC4 stream.
            # We intercept after server_decrypt so we re-encrypt for client.
            # But we pass raw data to client socket — the client expects RC4-encrypted data.
            # The client uses its OWN RC4 stream to decrypt. We don't have client_encrypt.
            # HOWEVER: we DO decrypt downstream and then forward the ORIGINAL encrypted bytes.
            # To inject downstream, we need to encrypt with the client's RC4 key at the current stream position.
            # We don't track that. Let's use a different approach:
            # Send the plaintext directly — but that breaks RC4 stream sync.
            # 
            # ALTERNATIVE: Modify handle_downstream to splice in extra plaintext frames
            # before re-forwarding. We'll store pending downstream injections.
            if not hasattr(session, '_pending_downstream'):
                session._pending_downstream = bytearray()
            session._pending_downstream.extend(plaintext)
            session.log(f"INJECT_DOWN queued {len(plaintext)} bytes, {len(results)} frames")
            self._json_response(200, {"ok": True, "queued": True, "frames": results,
                                       "note": "Will be spliced into next downstream packet"})

        def _json_response(self, code: int, obj: dict) -> None:
            payload = json.dumps(obj).encode("utf-8")
            self._write_response(code, "application/json", payload)

        def log_message(self, format: str, *args) -> None:
            return

    return ControlHandler


class QuietThreadingHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address) -> None:
        _exc_type, exc, _tb = sys.exc_info()
        if isinstance(exc, (BrokenPipeError, ConnectionAbortedError, ConnectionResetError)) or getattr(exc, "winerror", None) in (10053, 10054) or getattr(exc, "errno", None) in (32, 54, 104):
            return
        super().handle_error(request, client_address)


def start_http_server(registry: ProxyRegistry) -> ThreadingHTTPServer:
    server = QuietThreadingHTTPServer((registry.config.http_host, registry.config.http_port), make_handler(registry))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    line = f"[HTTP] http://{registry.config.http_host}:{registry.config.http_port}"
    registry.file_logger.write_proxy(line)
    print(line, flush=True)
    return server


def main(argv: Optional[List[str]] = None) -> int:
    args = build_arg_parser().parse_args(argv)
    config = ProxyConfig(
        mode=args.mode,
        listen_host=args.listen_host,
        listen_port=args.listen_port,
        remote_host=args.remote_host,
        remote_port=args.remote_port,
        http_host=args.http_host,
        http_port=args.http_port,
        multiply=sanitize_multiply(args.multiply),
        flood=args.flood,
        flood_interval=args.flood_interval,
        move_punch=args.move_punch,
        move_punch_copies=sanitize_multiply(args.move_punch_copies),
        move_punch_delay_ms=sanitize_delay_ms(args.move_punch_delay_ms),
        move_punch_spacing_ms=sanitize_delay_ms(args.move_punch_spacing_ms),
        move_punch_target=normalize_target_id(args.move_punch_target) or "",
        step_punch=args.step_punch,
        echo_punch=args.echo_punch,
        echo_punch_copies=sanitize_extra_copies(args.echo_punch_copies),
        echo_punch_delay_ms=sanitize_delay_ms(args.echo_punch_delay_ms),
        echo_punch_spacing_ms=sanitize_delay_ms(args.echo_punch_spacing_ms),
        proxy_contact_counter=args.proxy_contact_counter,
        proxy_contact_copies=sanitize_proxy_contact_copies(args.proxy_contact_copies),
        proxy_contact_targets=sanitize_proxy_contact_targets(args.proxy_contact_targets),
        proxy_contact_min_gap_ms=sanitize_proxy_contact_gap_ms(args.proxy_contact_min_gap_ms),
        proxy_contact_ladder_ms=sanitize_proxy_contact_ladder_ms(args.proxy_contact_ladder_ms),
        proxy_contact_ladder_steps=sanitize_proxy_contact_ladder_steps(args.proxy_contact_ladder_steps),
        proxy_contact_axis=sanitize_proxy_contact_axis(args.proxy_contact_axis),
        packet_brain=args.packet_brain,
        packet_brain_copies=sanitize_proxy_contact_copies(args.packet_brain_copies),
        packet_brain_targets=sanitize_proxy_contact_targets(args.packet_brain_targets),
        packet_brain_ladder_ms=sanitize_packet_brain_ladder_ms(args.packet_brain_ladder_ms),
        packet_brain_ladder_steps=sanitize_packet_brain_ladder_steps(args.packet_brain_ladder_steps),
        swf_key=args.swf_key,
        detailed_events=args.detailed_events,
        live_historical=args.live_historical,
        verbose=args.verbose,
        log_dir=args.log_dir,
    )
    registry = ProxyRegistry(config)
    banner = [
        "=" * 60,
        "BoomBang definitive proxy",
        f"build     : {PROXY_BUILD}",
        "=" * 60,
        f"mode      : {config.mode}",
        f"listen    : {config.listen_host}:{config.listen_port}",
        f"remote    : {config.remote_host}:{config.remote_port}",
        f"http      : {config.http_host}:{config.http_port}",
        f"multiply  : {config.multiply}x",
        f"movePunch : {'on' if config.move_punch else 'off'} copies={config.move_punch_copies} delay={config.move_punch_delay_ms}ms spacing={config.move_punch_spacing_ms}ms target={config.move_punch_target or 'captured'}",
        f"stepPunch : {'on' if config.step_punch else 'off'}",
        f"echoPunch : {'on' if config.echo_punch else 'off'} copies={config.echo_punch_copies} delay={config.echo_punch_delay_ms}ms spacing={config.echo_punch_spacing_ms}ms",
        f"proxyContact: {'on' if config.proxy_contact_counter else 'off'} copies={config.proxy_contact_copies} targets={config.proxy_contact_targets} gap={config.proxy_contact_min_gap_ms}ms ladder={config.proxy_contact_ladder_ms}ms/{config.proxy_contact_ladder_steps} axis={config.proxy_contact_axis}",
        f"packetBrain: {'on' if config.packet_brain else 'off'} copies={config.packet_brain_copies} targets={config.packet_brain_targets} ladder={config.packet_brain_ladder_ms}ms/{config.packet_brain_ladder_steps}",
        f"swfKey    : {'on' if config.swf_key else 'off'}",
        f"detail    : events={'on' if config.detailed_events else 'off'} historical={'on' if config.live_historical else 'off'}",
        f"logs      : {registry.file_logger.run_dir}",
        "=" * 60,
    ]
    for line in banner:
        registry.file_logger.write_proxy(line)
        print(line, flush=True)
    start_http_server(registry)

    listeners: List[socket.socket] = []

    def add_listener(port: int) -> None:
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            listener.bind((config.listen_host, port))
            listener.listen(16)
        except OSError as exc:
            listener.close()
            line_fail = f"[TCP] listen failed on {config.listen_host}:{port}: {exc}"
            registry.file_logger.write_proxy(line_fail)
            print(line_fail, flush=True)
            return
        listeners.append(listener)
        line_ok = f"[TCP] listening on {config.listen_host}:{port}"
        registry.file_logger.write_proxy(line_ok)
        print(line_ok, flush=True)

    listen_ports = [config.listen_port]
    if config.listen_port != FALLBACK_LISTEN_PORT:
        listen_ports.append(FALLBACK_LISTEN_PORT)
    for port in listen_ports:
        add_listener(port)
    if not listeners:
        registry.file_logger.close()
        return 2

    def accept_loop(listener: socket.socket) -> None:
        while True:
            try:
                client_sock, client_addr = listener.accept()
            except OSError:
                break
            session = ProxySession(registry.allocate_session_id(), config, registry, client_sock, client_addr)
            session.start()

    accept_threads: List[threading.Thread] = []
    for listener in listeners:
        thread = threading.Thread(target=accept_loop, args=(listener,), daemon=True)
        thread.start()
        accept_threads.append(thread)

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        line = "[PROXY] shutting down"
        registry.file_logger.write_proxy(line)
        print(f"\n{line}", flush=True)
    finally:
        for listener in listeners:
            try:
                listener.close()
            except OSError:
                pass
        registry.file_logger.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
