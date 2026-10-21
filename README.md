# 📦 Sistema de Encargos, Envíos y Apartados (PWA)

Sistema web progresivo (**PWA Offline-First**) para gestión de apartados, logística de rutas, abonos parciales y sincronización en tiempo real con **Supabase**.

---

## 🚀 Despliegue en GitHub Pages

Esta aplicación es **100% estática (HTML5, Vanilla CSS y ES Modules)**, por lo que **no requiere ningún servidor backend de pago**. Puedes alojarla directamente y gratis en **GitHub Pages**:

1. Sube este repositorio a tu cuenta de GitHub.
2. Ve a la pestaña **Settings** (Configuración) de tu repositorio.
3. En el menú lateral izquierdo, haz clic en **Pages**.
4. En **Build and deployment > Source**, selecciona **Deploy from a branch**.
5. En **Branch**, selecciona `main` (o `master`) y carpeta `/(root)`.
6. Haz clic en **Save** (Guardar).
7. En unos segundos, GitHub te proporcionará la URL pública (ejemplo: `https://tu-usuario.github.io/tu-repositorio/`).

---

## 🔑 Credenciales Predeterminadas (Demo / Primer Inicio)

| Rol | Usuario | Contraseña | Permisos |
| :--- | :--- | :--- | :--- |
| 👑 **Administrador** | `admin` | `admin123` | Control total, finanzas, métricas, gestión de usuarios, conexión a Supabase y modo ruta |
| 🚚 **Despachador** | `carlos` | `1234` | Solo entregas, búsqueda rápida, abonos y rutas Maps (Configuración y Finanzas ocultas) |

*Puedes crear más usuarios o modificar contraseñas desde **⚙️ Configuración ➔ Usuarios y Cargos**.*

---

## ☁️ Conexión con Supabase

1. Crea un proyecto gratuito en [supabase.com](https://supabase.com).
2. En la aplicación, ingresa como Administrador a **⚙️ Configuración ➔ Nube (Supabase)**.
3. Haz clic en **`📋 Ver Script SQL para Supabase`**, copia el script y ejecútalo en el **SQL Editor** de tu panel de Supabase.
4. Pega tu **Supabase Project URL** y tu **Anon Key pública** en la aplicación y pulsa **`Probar Conexión Supabase`** y **`Guardar Configuración`**.
5. Los datos se sincronizarán en tiempo real bidireccionalmente con protección **Anti-Pisado (Last-Write-Wins)**.

---

## 📱 Instalación como App Móvil (PWA)

- **Android (Chrome):** Menú de 3 puntos ➔ *Instalar aplicación* o *Agregar a la pantalla principal*.
- **iOS (Safari):** Botón Compartir ➔ *Agregar a inicio*.
- **PC / Mac (Chrome, Edge):** Ícono de instalación en la barra de direcciones.

---

## 🛠️ Tecnologías Utilizadas

- **Frontend:** HTML5 semántico, CSS3 moderno (Dark/Light mode, Glassmorphism, Micro-animaciones).
- **Lógica:** Vanilla JavaScript (ES Modules).
- **Almacenamiento Local:** IndexedDB nativo (100% operativo sin internet).
- **Sincronización:** Supabase Realtime & PostgreSQL Replication.
- **Service Worker:** Estrategia Stale-While-Revalidate con caché v1.5.0.
