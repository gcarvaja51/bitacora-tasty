# Pone la imagen corporativa de Iron Balls al principio y al final del reel:
# marca/marca_inicio.mp4 y marca/marca_final.mp4 (rayo + logo del video de Iron Balls del 18-nov en el grupo
# "Operaciones by Iron Balls" + coro de la canción de Iron Balls, sacado del inicio de la transmisión de YouTube del 25-nov, qIKdCLPG74w).
# Uso: python envolver_marca.py   (después de render.py)  ->  reel_trade_emerson_2026-11-25.mp4 queda con la marca.
import os, subprocess, shutil
V = os.path.dirname(os.path.abspath(__file__)); M = os.path.join(V, 'marca')
cuerpo = os.path.join(V, 'reel_trade_emerson_2026-11-25_cuerpo.mp4'); final = os.path.join(V, 'reel_trade_emerson_2026-11-25.mp4')
subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', os.path.join(M, 'marca_inicio.mp4'), '-i', cuerpo, '-i', os.path.join(M, 'marca_final.mp4'),
                '-filter_complex', '[0:v]setsar=1[v0];[1:v]setsar=1,fps=24[v1];[2:v]setsar=1[v2];[1:a]aresample=44100[a1];'
                '[v0][0:a][v1][a1][v2][2:a]concat=n=3:v=1:a=1[v][a]',
                '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20',
                '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', final], check=True)
print('ok', final)
