/**
 * DestinationService - DeepSeek Harness Provider
 * Catálogo de Destinos, Rutas, Georreferenciación y parsing de ubicaciones de WhatsApp/Google Maps.
 */

import { storageService } from './storage.service.js';
import { supabaseService } from './supabase.service.js';

const SEED_FLAG_KEY = 'destinations_seed_v1_completed';
const DELETED_DESTINATIONS_KEY = 'deleted_destinations_v1';

class DestinationService {
  generateId() {
    return 'DST-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6);
  }

  // Obtener todos los destinos ordenados por ciudad y nombre
  async getAllDestinations() {
    await this.seedDefaultDestinationsIfEmpty();
    const destinations = await storageService.getAll('destinations');

    // Filtrar cualquier destino que el usuario haya eliminado explícitamente
    let deletedIds = [];
    try {
      deletedIds = JSON.parse(localStorage.getItem(DELETED_DESTINATIONS_KEY) || '[]');
    } catch (e) {}

    const validDestinations = Array.isArray(deletedIds) && deletedIds.length > 0
      ? destinations.filter(d => !deletedIds.includes(d.id))
      : destinations;

    return validDestinations.sort((a, b) => (a.ciudad || '').localeCompare(b.ciudad || '') || (a.nombre || '').localeCompare(b.nombre || ''));
  }

  async getDestinationById(id) {
    return storageService.getById('destinations', id);
  }

  // Guardar o actualizar un destino / ubicación frecuente
  async saveDestination(destData) {
    localStorage.setItem(SEED_FLAG_KEY, 'true');
    const now = new Date().toISOString();
    
    // Si estaba marcado en la lista de eliminados, restaurar permiso para este ID
    if (destData.id) {
      try {
        let deletedIds = JSON.parse(localStorage.getItem(DELETED_DESTINATIONS_KEY) || '[]');
        if (deletedIds.includes(destData.id)) {
          deletedIds = deletedIds.filter(x => x !== destData.id);
          localStorage.setItem(DELETED_DESTINATIONS_KEY, JSON.stringify(deletedIds));
        }
      } catch (e) {}
    }

    // Parsear link de WhatsApp / Google Maps
    let parsedMapsUrl = (destData.mapsUrl || '').trim();
    let lat = destData.lat !== undefined && destData.lat !== null && destData.lat !== '' ? Number(destData.lat) : null;
    let lng = destData.lng !== undefined && destData.lng !== null && destData.lng !== '' ? Number(destData.lng) : null;

    // Si el usuario pegó un link de coordenadas directo (ej. https://maps.google.com/?q=-17.3895,-66.1568 o texto "-17.3895, -66.1568")
    if (parsedMapsUrl && !lat && !lng) {
      const coordMatch = parsedMapsUrl.match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
      if (coordMatch) {
        lat = Number(coordMatch[1]);
        lng = Number(coordMatch[2]);
      }
    }

    const destination = {
      id: destData.id || this.generateId(),
      nombre: (destData.nombre || '').trim() || 'Punto de Entrega',
      ciudad: (destData.ciudad || '').trim() || 'General',
      direccion: (destData.direccion || '').trim(),
      categoria: destData.categoria || 'Terminal', // 'Terminal' | 'Punto de Encuentro' | 'Almacén / Tienda' | 'Domicilio'
      mapsUrl: parsedMapsUrl,
      lat: isNaN(lat) ? null : lat,
      lng: isNaN(lng) ? null : lng,
      notas: (destData.notas || '').trim(),
      createdAt: destData.createdAt || now,
      updatedAt: now
    };

    await storageService.put('destinations', destination);
    supabaseService.pushRecord('destinations', destination).catch(() => {});
    return destination;
  }

  async deleteDestination(id) {
    localStorage.setItem(SEED_FLAG_KEY, 'true');

    // Registrar ID eliminado para que la sincronización con la nube no lo resucite
    try {
      let deletedIds = JSON.parse(localStorage.getItem(DELETED_DESTINATIONS_KEY) || '[]');
      if (!deletedIds.includes(id)) {
        deletedIds.push(id);
        localStorage.setItem(DELETED_DESTINATIONS_KEY, JSON.stringify(deletedIds));
      }
    } catch (e) {
      console.warn('Error al guardar tombstone de destino:', e);
    }

    supabaseService.pushDelete('destinations', id).catch(() => {});
    return storageService.delete('destinations', id);
  }

  async searchDestinations(query) {
    const all = await this.getAllDestinations();
    if (!query) return all;
    const q = query.toLowerCase().trim();
    return all.filter(d => 
      (d.nombre && d.nombre.toLowerCase().includes(q)) ||
      (d.ciudad && d.ciudad.toLowerCase().includes(q)) ||
      (d.direccion && d.direccion.toLowerCase().includes(q)) ||
      (d.categoria && d.categoria.toLowerCase().includes(q))
    );
  }

  // Generar URL directa para trazar ruta en Google Maps
  getRouteUrl(dest) {
    if (!dest) return 'https://www.google.com/maps';

    if (dest.mapsUrl && dest.mapsUrl.startsWith('http')) {
      return dest.mapsUrl;
    }

    if (dest.lat && dest.lng) {
      return `https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lng}`;
    }

    const parts = [];
    if (dest.direccion) parts.push(dest.direccion);
    if (dest.nombre) parts.push(dest.nombre);
    if (dest.ciudad) parts.push(dest.ciudad);

    const query = parts.join(', ').trim();
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(query || dest.ciudad || 'Bolivia')}`;
  }

  // Precargar destinos por defecto SOLO la primera vez que se inicia la app limpia
  async seedDefaultDestinationsIfEmpty() {
    // Si ya se procesó la siembra inicial alguna vez en este navegador, NUNCA volver a sembrar
    if (localStorage.getItem(SEED_FLAG_KEY) === 'true') {
      return;
    }

    const existing = await storageService.getAll('destinations');
    if (existing.length > 0) {
      localStorage.setItem(SEED_FLAG_KEY, 'true');
      return;
    }

    // Marcar como sembrado de inmediato para que si el usuario los elimina no vuelvan a aparecer
    localStorage.setItem(SEED_FLAG_KEY, 'true');

    const defaults = [
      {
        id: 'DST-SCZ-BIMODAL',
        nombre: 'Terminal Bimodal Santa Cruz',
        ciudad: 'Santa Cruz',
        direccion: 'Av. Intermodal entre 3er y 4to Anillo',
        categoria: 'Terminal',
        mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Terminal+Bimodal+Santa+Cruz',
        lat: -17.7946,
        lng: -63.1611,
        notas: 'Sector encomiendas puerta norte, arribo habitual de viajes'
      },
      {
        id: 'DST-CBB-CENTRAL',
        nombre: 'Terminal de Buses Cochabamba',
        ciudad: 'Cochabamba',
        direccion: 'Av. Ayacucho esq. Tarata',
        categoria: 'Terminal',
        mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Terminal+de+Buses+Cochabamba',
        lat: -17.4042,
        lng: -66.1558,
        notas: 'Punto central de descarga y retiro'
      },
      {
        id: 'DST-LPZ-CENTRAL',
        nombre: 'Terminal Central La Paz',
        ciudad: 'La Paz',
        direccion: 'Plaza Antofagasta s/n, Zona Challapampa',
        categoria: 'Terminal',
        mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Terminal+de+Buses+La+Paz',
        lat: -16.4912,
        lng: -68.1408,
        notas: 'Oficinas de encomiendas de flotas'
      },
      {
        id: 'DST-CBB-OFICINA',
        nombre: 'Oficina / Centro de Entregas Heroínas',
        ciudad: 'Cochabamba',
        direccion: 'Av. Heroínas #456 entre San Martín y 25 de Mayo',
        categoria: 'Almacén / Tienda',
        mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Av+Heroinas+Cochabamba',
        lat: -17.3934,
        lng: -66.1571,
        notas: 'Retiro en horario continuo de 09:00 a 19:00'
      }
    ];

    for (const d of defaults) {
      await storageService.put('destinations', d);
    }
  }
}

export const destinationService = new DestinationService();
