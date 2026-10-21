/**
 * CloudService - DeepSeek Harness Provider
 * Conexión y sincronización opcional con Supabase / Firebase y utilidades de respaldo JSON.
 */

import { storageService } from './storage.service.js';
import { syncService } from './sync.service.js';

class CloudService {
  // Descargar archivo de respaldo JSON localmente
  async exportBackupToFile() {
    const backupData = await storageService.exportDatabase();
    const jsonString = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(backupData, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', jsonString);
    const dateStr = new Date().toISOString().slice(0, 10);
    downloadAnchor.setAttribute('download', `respaldo_encargos_${dateStr}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    return true;
  }

  // Cargar respaldo desde archivo JSON seleccionado por el usuario con protección anti-pisado
  async importBackupFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const content = JSON.parse(e.target.result);
          const result = await syncService.safeImportBackup(content);
          resolve(result);
        } catch (err) {
          reject(new Error('Archivo JSON corrupto o con formato no compatible: ' + err.message));
        }
      };
      reader.onerror = () => reject(new Error('Error al leer el archivo.'));
      reader.readAsText(file);
    });
  }

  // Probar conectividad y estado de tablas con Supabase
  async testSupabaseConnection(url, anonKey) {
    if (!url || !anonKey) {
      return { success: false, message: 'Debes ingresar la URL y la Anon Key de Supabase.' };
    }
    try {
      const { supabaseService } = await import('./supabase.service.js');
      return await supabaseService.testConnection(url, anonKey);
    } catch (err) {
      const cleanUrl = url.replace(/\/+$/, '');
      try {
        const response = await fetch(`${cleanUrl}/rest/v1/`, {
          headers: {
            'apikey': anonKey,
            'Authorization': `Bearer ${anonKey}`
          }
        });
        if (response.ok || response.status === 200 || response.status === 404) {
          return { success: true, message: '¡Conexión básica establecida con el endpoint REST de Supabase!' };
        } else {
          return { success: false, message: `Respuesta del servidor: HTTP ${response.status} ${response.statusText}` };
        }
      } catch (fetchErr) {
        return { success: false, message: 'No se pudo conectar: ' + fetchErr.message };
      }
    }
  }

  // Cargar datos de demostración si la base de datos está vacía o el usuario lo solicita
  async seedDemoData() {
    const existingCustomers = await storageService.getAll('customers');
    if (existingCustomers.length > 0) {
      // Ya hay datos
      return false;
    }

    const demoCustomers = [
      {
        id: 'CLI-demo-1',
        nombre: 'Carlos Mendoza',
        telefono: '+59172345678',
        email: 'carlos.mendoza@email.com',
        documentoIdentidad: '7829102 SC',
        ciudadDefault: 'Santa Cruz',
        direccionDefault: 'Av. Banzer 4to Anillo #320',
        saldoFavor: 0,
        notas: 'Siempre pide calzados y tecnología',
        createdAt: new Date(Date.now() - 86400000 * 5).toISOString()
      },
      {
        id: 'CLI-demo-2',
        nombre: 'Mariana Ríos',
        telefono: '+59168912345',
        email: 'mariana.rios@email.com',
        documentoIdentidad: '9481726 CB',
        ciudadDefault: 'Cochabamba',
        direccionDefault: 'Plaza Colón, Edif. Los Pinos Piso 3',
        saldoFavor: 0,
        notas: 'Paga puntual por transferencia QR',
        createdAt: new Date(Date.now() - 86400000 * 12).toISOString()
      },
      {
        id: 'CLI-demo-3',
        nombre: 'Alejandro Vargas',
        telefono: '+59171098765',
        email: 'alejandro.v@email.com',
        documentoIdentidad: '6572819 LP',
        ciudadDefault: 'La Paz',
        direccionDefault: 'Zona Sur, Calacoto Calle 15',
        saldoFavor: 0,
        notas: 'Cliente con sistema por apartado activo',
        createdAt: new Date(Date.now() - 86400000 * 20).toISOString()
      }
    ];

    for (const c of demoCustomers) {
      await storageService.put('customers', c);
    }

    const demoOrders = [
      {
        id: 'ENC-20261018-4821',
        clienteId: 'CLI-demo-1',
        clienteNombre: 'Carlos Mendoza',
        clienteTelefono: '+59172345678',
        modalidad: 'encargo_apartado',
        fechaCreacion: new Date(Date.now() - 86400000 * 2).toISOString(),
        fechaEntregaEstimada: '2026-10-25',
        lugarDestino: {
          ciudad: 'Santa Cruz',
          puntoEntrega: 'Terminal Bimodal',
          direccion: 'Av. Intermodal s/n'
        },
        items: [
          {
            id: 'itm-1',
            descripcion: 'Smartwatch Amazfit GTR 4',
            cantidad: 1,
            precioUnitario: 140.00,
            notas: 'Color Negro medianoche',
            enlaceReferencia: ''
          }
        ],
        costoItems: 140.00,
        costoEnvioComision: 15.00,
        costoTotal: 155.00,
        anticipoExigidoTipo: 'porcentaje',
        anticipoExigidoValor: 50,
        montoAnticipoCalculado: 77.50,
        historialAbonos: [
          {
            id: 'abn-1',
            fecha: new Date(Date.now() - 86400000 * 2).toISOString(),
            monto: 80.00,
            metodo: 'Transferencia QR',
            comprobanteRef: 'QR-8271',
            concepto: 'Anticipo inicial'
          }
        ],
        totalAbonado: 80.00,
        saldoPendiente: 75.00,
        porcentajePagado: 52,
        estado: 'anticipo_pagado',
        notasInternas: 'Comprar en distribuidor autorizado'
      },
      {
        id: 'ENC-20261015-9923',
        clienteId: 'CLI-demo-2',
        clienteNombre: 'Mariana Ríos',
        clienteTelefono: '+59168912345',
        modalidad: 'encargo_apartado',
        fechaCreacion: new Date(Date.now() - 86400000 * 6).toISOString(),
        fechaEntregaEstimada: '2026-10-23',
        lugarDestino: {
          ciudad: 'Cochabamba',
          puntoEntrega: 'Oficina Central',
          direccion: 'Av. Heroínas #456'
        },
        items: [
          {
            id: 'itm-2',
            descripcion: 'Vestido de Gala Seda Azul Noche Talla M',
            cantidad: 1,
            precioUnitario: 95.00,
            notas: 'Empaque para viaje',
            enlaceReferencia: ''
          },
          {
            id: 'itm-3',
            descripcion: 'Set de Brochas Profesionales Real Techniques',
            cantidad: 1,
            precioUnitario: 35.00,
            notas: 'Edición limitada',
            enlaceReferencia: ''
          }
        ],
        costoItems: 130.00,
        costoEnvioComision: 10.00,
        costoTotal: 140.00,
        anticipoExigidoTipo: 'porcentaje',
        anticipoExigidoValor: 50,
        montoAnticipoCalculado: 70.00,
        historialAbonos: [
          {
            id: 'abn-2',
            fecha: new Date(Date.now() - 86400000 * 6).toISOString(),
            monto: 70.00,
            metodo: 'Efectivo',
            comprobanteRef: 'EFE-102',
            concepto: 'Anticipo 50%'
          },
          {
            id: 'abn-3',
            fecha: new Date(Date.now() - 86400000 * 1).toISOString(),
            monto: 70.00,
            metodo: 'Transferencia QR',
            comprobanteRef: 'QR-9901',
            concepto: 'Cancelación total / Liquidación'
          }
        ],
        totalAbonado: 140.00,
        saldoPendiente: 0.00,
        porcentajePagado: 100,
        estado: 'liquidado_total',
        fechaLiquidacion: new Date(Date.now() - 86400000 * 1).toISOString(),
        notasInternas: 'Listo para entregar en el próximo viaje'
      },
      {
        id: 'ENC-20261010-3312',
        clienteId: 'CLI-demo-3',
        clienteNombre: 'Alejandro Vargas',
        clienteTelefono: '+59171098765',
        modalidad: 'encargo_apartado',
        fechaCreacion: new Date(Date.now() - 86400000 * 10).toISOString(),
        fechaEntregaEstimada: '2026-10-28',
        lugarDestino: {
          ciudad: 'La Paz',
          puntoEntrega: 'Terminal de Buses La Paz',
          direccion: 'Plaza Antofagasta'
        },
        items: [
          {
            id: 'itm-4',
            descripcion: 'Laptop Gamer ASUS TUF A15 16GB RAM',
            cantidad: 1,
            precioUnitario: 850.00,
            notas: 'Verificar sello de fábrica y teclado en español',
            enlaceReferencia: ''
          }
        ],
        costoItems: 850.00,
        costoEnvioComision: 40.00,
        costoTotal: 890.00,
        anticipoExigidoTipo: 'porcentaje',
        anticipoExigidoValor: 40,
        montoAnticipoCalculado: 356.00,
        historialAbonos: [
          {
            id: 'abn-4',
            fecha: new Date(Date.now() - 86400000 * 10).toISOString(),
            monto: 360.00,
            metodo: 'Transferencia Bancaria',
            comprobanteRef: 'TR-4821',
            concepto: 'Apartado inicial'
          },
          {
            id: 'abn-5',
            fecha: new Date(Date.now() - 86400000 * 3).toISOString(),
            monto: 200.00,
            metodo: 'Transferencia QR',
            comprobanteRef: 'QR-1144',
            concepto: 'Segundo abono de apartado'
          }
        ],
        totalAbonado: 560.00,
        saldoPendiente: 330.00,
        porcentajePagado: 63,
        estado: 'anticipo_pagado',
        notasInternas: 'Apartado en proceso. Espera fecha de entrega en La Paz'
      }
    ];

    for (const o of demoOrders) {
      await storageService.put('orders', o);
    }

    return true;
  }
}

export const cloudService = new CloudService();
