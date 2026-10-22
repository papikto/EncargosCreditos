/**
 * OrderService - DeepSeek Harness Provider
 * Motor de Encargos, Sistema por Apartado (Layaway), Abonos Parciales y Liquidación Rápida.
 */

import { storageService } from './storage.service.js';
import { supabaseService } from './supabase.service.js';

class OrderService {
  generateOrderId() {
    const datePart = new Date().toISOString().slice(2, 10).replace(/-/g, '');
    const randomPart = Math.floor(1000 + Math.random() * 9000);
    return `ENC-${datePart}-${randomPart}`;
  }

  // Obtener todos los pedidos
  async getAllOrders() {
    const orders = await storageService.getAll('orders');
    const uniqueMap = new Map();
    orders.forEach(o => {
      if (!o || !o.id) return;
      const isAcquired = Boolean(o.adquirido);
      // Regla de negocio estricta: Si no está adquirido, NO puede estar entregado
      const isDelivered = isAcquired ? (o.entregado !== undefined ? Boolean(o.entregado) : Boolean(o.estado === 'entregado')) : false;
      uniqueMap.set(o.id, {
        ...o,
        adquirido: isAcquired,
        entregado: isDelivered,
        archivado: Boolean(o.archivado)
      });
    });
    return Array.from(uniqueMap.values()).sort((a, b) => new Date(b.fechaCreacion || 0) - new Date(a.fechaCreacion || 0));
  }

  // Obtener un pedido por ID
  async getOrderById(orderId) {
    const order = await storageService.getById('orders', orderId);
    if (!order) return null;
    const isAcquired = Boolean(order.adquirido);
    const isDelivered = isAcquired ? (order.entregado !== undefined ? Boolean(order.entregado) : Boolean(order.estado === 'entregado')) : false;
    return {
      ...order,
      adquirido: isAcquired,
      entregado: isDelivered,
      archivado: Boolean(order.archivado)
    };
  }

  // Crear o actualizar un encargo / apartado
  async saveOrder(orderData) {
    const isNew = !orderData.id;
    const now = new Date().toISOString();

    // Normalizar items y calcular costos
    const items = (orderData.items || []).map(item => ({
      id: item.id || 'itm-' + Math.random().toString(36).substring(2, 7),
      descripcion: item.descripcion.trim(),
      cantidad: Number(item.cantidad) || 1,
      precioUnitario: Number(item.precioUnitario) || 0,
      notas: item.notas ? item.notas.trim() : '',
      enlaceReferencia: item.enlaceReferencia ? item.enlaceReferencia.trim() : ''
    }));

    const costoItems = items.reduce((sum, item) => sum + (item.cantidad * item.precioUnitario), 0);
    const costoEnvioComision = Number(orderData.costoEnvioComision) || 0;
    const costoTotal = Math.round((costoItems + costoEnvioComision) * 100) / 100;

    // Cálculo del anticipo exigido
    const anticipoTipo = orderData.anticipoExigidoTipo || 'porcentaje'; // 'porcentaje' | 'fijo'
    let anticipoValor = Number(orderData.anticipoExigidoValor);
    if (isNaN(anticipoValor)) anticipoValor = 50;

    let montoAnticipoCalculado = 0;
    if (anticipoTipo === 'porcentaje') {
      montoAnticipoCalculado = Math.round((costoTotal * (anticipoValor / 100)) * 100) / 100;
    } else {
      montoAnticipoCalculado = Math.min(costoTotal, anticipoValor);
    }

    // Historial de abonos
    const historialAbonos = Array.isArray(orderData.historialAbonos) ? [...orderData.historialAbonos] : [];

    // Si es nuevo y se proporcionó un primer abono en la creación
    if (isNew && Number(orderData.primerAbono) > 0) {
      historialAbonos.push({
        id: 'abn-' + Date.now().toString(36),
        fecha: now,
        monto: Number(orderData.primerAbono),
        metodo: orderData.primerAbonoMetodo || 'Efectivo',
        comprobanteRef: orderData.primerAbonoRef || '',
        concepto: 'Anticipo inicial'
      });
    }

    // Calcular totales abonados y saldos
    const totalAbonado = Math.round(historialAbonos.reduce((acc, a) => acc + (Number(a.monto) || 0), 0) * 100) / 100;
    const saldoPendiente = Math.max(0, Math.round((costoTotal - totalAbonado) * 100) / 100);
    const porcentajePagado = costoTotal > 0 ? Math.min(100, Math.round((totalAbonado / costoTotal) * 100)) : 0;

    // Determinar estado financiero/logístico
    let estado = orderData.estado || 'pendiente_anticipo';
    if (saldoPendiente < 0.01 && costoTotal > 0) {
      if (estado !== 'entregado' && estado !== 'cancelado') {
        estado = 'liquidado_total';
      }
    } else if (totalAbonado >= montoAnticipoCalculado && totalAbonado > 0) {
      if (estado === 'pendiente_anticipo') {
        estado = 'anticipo_pagado';
      }
    }

    const order = {
      id: orderData.id || this.generateOrderId(),
      clienteId: orderData.clienteId,
      clienteNombre: orderData.clienteNombre,
      clienteTelefono: orderData.clienteTelefono || '',
      modalidad: orderData.modalidad || 'encargo_apartado',
      fechaCreacion: orderData.fechaCreacion || now,
      fechaEntregaEstimada: orderData.fechaEntregaEstimada || '',
      lugarDestino: {
        ciudad: (orderData.lugarDestino && orderData.lugarDestino.ciudad) ? orderData.lugarDestino.ciudad.trim() : 'Destino General',
        puntoEntrega: (orderData.lugarDestino && orderData.lugarDestino.puntoEntrega) ? orderData.lugarDestino.puntoEntrega.trim() : '',
        direccion: (orderData.lugarDestino && orderData.lugarDestino.direccion) ? orderData.lugarDestino.direccion.trim() : '',
        mapsUrl: (orderData.lugarDestino && orderData.lugarDestino.mapsUrl) ? orderData.lugarDestino.mapsUrl.trim() : '',
        lat: (orderData.lugarDestino && orderData.lugarDestino.lat) ? Number(orderData.lugarDestino.lat) : null,
        lng: (orderData.lugarDestino && orderData.lugarDestino.lng) ? Number(orderData.lugarDestino.lng) : null
      },
      items,
      costoItems: Math.round(costoItems * 100) / 100,
      costoEnvioComision,
      costoTotal,
      anticipoExigidoTipo: anticipoTipo,
      anticipoExigidoValor: anticipoValor,
      montoAnticipoCalculado,
      historialAbonos,
      totalAbonado,
      saldoPendiente,
      porcentajePagado,
      estado,
      adquirido: Boolean(orderData.adquirido),
      fechaAdquisicion: orderData.fechaAdquisicion || null,
      entregado: Boolean(orderData.entregado || orderData.estado === 'entregado'),
      fechaEntregaReal: orderData.fechaEntregaReal || null,
      archivado: Boolean(orderData.archivado),
      notasInternas: orderData.notasInternas ? orderData.notasInternas.trim() : '',
      updatedAt: now
    };

    await storageService.put('orders', order);
    supabaseService.pushRecord('orders', order).catch(() => {});
    return order;
  }

  // Registrar un abono a un pedido (soporte de sistema por apartado)
  async addPayment(orderId, paymentData) {
    const order = await this.getOrderById(orderId);
    if (!order) throw new Error('Pedido no encontrado');

    const monto = Number(paymentData.monto);
    if (isNaN(monto) || monto <= 0) {
      throw new Error('El monto del abono debe ser mayor a 0');
    }

    const now = new Date().toISOString();
    const nuevoAbono = {
      id: 'abn-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 5),
      fecha: paymentData.fecha || now,
      monto: Math.round(monto * 100) / 100,
      metodo: paymentData.metodo || 'Efectivo',
      comprobanteRef: paymentData.comprobanteRef ? paymentData.comprobanteRef.trim() : '',
      concepto: paymentData.concepto || 'Abono / Cuota de apartado'
    };

    order.historialAbonos = order.historialAbonos || [];
    order.historialAbonos.push(nuevoAbono);

    // Recalcular
    order.totalAbonado = Math.round(order.historialAbonos.reduce((acc, a) => acc + (Number(a.monto) || 0), 0) * 100) / 100;
    order.saldoPendiente = Math.max(0, Math.round((order.costoTotal - order.totalAbonado) * 100) / 100);
    order.porcentajePagado = order.costoTotal > 0 ? Math.min(100, Math.round((order.totalAbonado / order.costoTotal) * 100)) : 100;

    // Actualizar estado si se liquidó
    if (order.saldoPendiente < 0.01) {
      if (order.estado !== 'entregado') {
        order.estado = 'liquidado_total';
      }
      order.fechaLiquidacion = now;
    } else if (order.totalAbonado >= order.montoAnticipoCalculado && order.estado === 'pendiente_anticipo') {
      order.estado = 'anticipo_pagado';
    }

    order.updatedAt = now;
    await storageService.put('orders', order);
    supabaseService.pushRecord('orders', order).catch(() => {});
    return { order, nuevoAbono };
  }

  // Cancelación total / Liquidación inmediata en 1 clic
  async settleFullBalance(orderId, metodo = 'Efectivo', referencia = 'Liquidación total en 1 clic') {
    const order = await this.getOrderById(orderId);
    if (!order) throw new Error('Pedido no encontrado');

    const saldoPendiente = order.saldoPendiente;
    if (saldoPendiente <= 0) {
      throw new Error('Este pedido ya se encuentra completamente pagado (saldo pendiente 0).');
    }

    return this.addPayment(orderId, {
      monto: saldoPendiente,
      metodo: metodo,
      comprobanteRef: referencia,
      concepto: 'Cancelación total / Liquidación de saldo'
    });
  }

  // Cambiar estado logístico del encargo
  async updateOrderStatus(orderId, nuevoEstado) {
    const order = await this.getOrderById(orderId);
    if (!order) throw new Error('Pedido no encontrado');
    order.estado = nuevoEstado;
    order.updatedAt = new Date().toISOString();
    await storageService.put('orders', order);
    supabaseService.pushRecord('orders', order).catch(() => {});
    return order;
  }

  // Alternar estado de productos adquiridos / comprados
  async toggleOrderAcquired(orderId) {
    const order = await this.getOrderById(orderId);
    if (!order) throw new Error('Pedido no encontrado');
    const now = new Date().toISOString();

    order.adquirido = !order.adquirido;
    order.fechaAdquisicion = order.adquirido ? now : null;

    // Si se desmarca la adquisición (por error o rectificación):
    // 1. También se desmarca la entrega física
    // 2. Si estaba archivado, se retira de archivados
    // 3. Se restablece el estado financiero correspondiente
    if (!order.adquirido) {
      order.entregado = false;
      order.fechaEntregaReal = null;
      order.archivado = false;
      delete order.fechaArchivado;
      if (order.saldoPendiente < 0.01 && order.costoTotal > 0) {
        order.estado = 'liquidado_total';
      } else if (order.totalAbonado >= order.montoAnticipoCalculado && order.totalAbonado > 0) {
        order.estado = 'anticipo_pagado';
      } else {
        order.estado = 'pendiente_anticipo';
      }
    }

    order.updatedAt = now;
    await storageService.put('orders', order);
    supabaseService.pushRecord('orders', order).catch(() => {});
    return order;
  }

  // Alternar estado de producto entregado al cliente
  async toggleOrderDelivered(orderId) {
    const order = await this.getOrderById(orderId);
    if (!order) throw new Error('Pedido no encontrado');

    const willBeDelivered = !order.entregado;

    // Regla de negocio requerida: Para poderse entregar primero se debe adquirir el producto y marcarse
    if (willBeDelivered && !order.adquirido) {
      throw new Error('No se puede entregar un encargo cuyos productos no han sido adquiridos.');
    }

    const now = new Date().toISOString();
    order.entregado = willBeDelivered;
    order.fechaEntregaReal = order.entregado ? now : null;
    
    // Si se entrega, se asegura que los productos fueron adquiridos
    if (order.entregado) {
      order.adquirido = true;
      if (!order.fechaAdquisicion) order.fechaAdquisicion = now;
      order.estado = 'entregado';
    } else {
      if (order.saldoPendiente < 0.01 && order.costoTotal > 0) {
        order.estado = 'liquidado_total';
      } else if (order.totalAbonado >= order.montoAnticipoCalculado && order.totalAbonado > 0) {
        order.estado = 'anticipo_pagado';
      } else {
        order.estado = 'pendiente_anticipo';
      }
    }
    
    order.updatedAt = now;
    await storageService.put('orders', order);
    supabaseService.pushRecord('orders', order).catch(() => {});
    return order;
  }

  // Finalizar encargo y marcar como entregado / archivado
  async finalizeOrder(orderId, fechaEntrega = null) {
    const order = await this.getOrderById(orderId);
    if (!order) throw new Error('Pedido no encontrado');
    const now = new Date().toISOString();
    order.entregado = true;
    order.adquirido = true;
    order.fechaEntregaReal = fechaEntrega || now;
    if (!order.fechaAdquisicion) order.fechaAdquisicion = now;
    order.estado = 'entregado';
    order.archivado = true;
    order.fechaArchivado = now;
    order.updatedAt = now;
    await storageService.put('orders', order);
    supabaseService.pushRecord('orders', order).catch(() => {});
    return order;
  }

  // Archivar encargo finalizado en historial
  async archiveFinalizedOrder(orderId) {
    const order = await this.getOrderById(orderId);
    if (!order) throw new Error('Pedido no encontrado');
    const now = new Date().toISOString();
    order.archivado = true;
    order.fechaArchivado = now;
    // Solo forzar adquirido/entregado si ya estaba marcado como entregado,
    // o si se está archivando un pedido completamente finalizado.
    // No se sobreescribe el estado de entrega si el pedido aún no fue entregado.
    if (order.entregado) {
      order.adquirido = true;
      if (!order.fechaAdquisicion) order.fechaAdquisicion = now;
      if (!order.fechaEntregaReal) order.fechaEntregaReal = now;
      order.estado = 'entregado';
    }
    order.updatedAt = now;
    await storageService.put('orders', order);
    supabaseService.pushRecord('orders', order).catch(() => {});
    return order;
  }

  // Desarchivar encargo y restaurarlo en activos (Solo Administrador)
  async unarchiveOrder(orderId) {
    const order = await this.getOrderById(orderId);
    if (!order) throw new Error('Pedido no encontrado');
    const now = new Date().toISOString();
    order.archivado = false;
    order.updatedAt = now;
    await storageService.put('orders', order);
    supabaseService.pushRecord('orders', order).catch(() => {});
    return order;
  }

  // Reabrir encargo finalizado para regresarlo a pedidos activos
  async reopenOrder(orderId) {
    const order = await this.getOrderById(orderId);
    if (!order) throw new Error('Pedido no encontrado');
    const now = new Date().toISOString();
    order.entregado = false;
    order.archivado = false;
    delete order.fechaEntregaReal;
    if (order.saldoPendiente < 0.01 && order.costoTotal > 0) {
      order.estado = 'liquidado_total';
    } else if (order.totalAbonado >= order.montoAnticipoCalculado && order.totalAbonado > 0) {
      order.estado = 'anticipo_pagado';
    } else {
      order.estado = 'pendiente_anticipo';
    }
    order.updatedAt = now;
    await storageService.put('orders', order);
    supabaseService.pushRecord('orders', order).catch(() => {});
    return order;
  }

  // Eliminar un encargo
  async deleteOrder(orderId) {
    supabaseService.pushDelete('orders', orderId).catch(() => {});
    return storageService.delete('orders', orderId);
  }

  // Detecta y limpia automáticamente pedidos duplicados fantasmas generados por desincronizaciones
  async cleanDuplicateGhostOrders() {
    const orders = await storageService.getAll('orders');
    if (!orders || orders.length <= 1) return [];

    const mapByContent = new Map();
    const duplicatesToDelete = [];

    for (const order of orders) {
      if (!order || !order.id) continue;
      const clientName = (order.clienteNombre || '').trim().toLowerCase();
      const total = Number(order.costoTotal || 0).toFixed(2);
      const itemsSig = (order.items || [])
        .map(i => `${(i.descripcion || '').trim().toLowerCase()}_${i.cantidad}_${Number(i.precioUnitario || 0).toFixed(2)}`)
        .sort()
        .join(';;');

      const sig = `${clientName}__${total}__${itemsSig}`;
      if (!clientName && total === '0.00') continue;

      if (!mapByContent.has(sig)) {
        mapByContent.set(sig, order);
      } else {
        const existing = mapByContent.get(sig);
        let toKeep = existing;
        let toDelete = order;

        // Criterio de preservación inteligente:
        // 1. Si uno está archivado y el otro no, conservar el archivado
        if (order.archivado && !existing.archivado) {
          toKeep = order;
          toDelete = existing;
          mapByContent.set(sig, order);
        } else if (!order.archivado && existing.archivado) {
          toKeep = existing;
          toDelete = order;
        } else {
          // 2. Si ambos están en igual estado, conservar el que tenga más historial de abonos o sea más reciente
          const orderAbonos = (order.historialAbonos || []).length;
          const existingAbonos = (existing.historialAbonos || []).length;
          if (orderAbonos > existingAbonos) {
            toKeep = order;
            toDelete = existing;
            mapByContent.set(sig, order);
          } else {
            toKeep = existing;
            toDelete = order;
          }
        }

        duplicatesToDelete.push(toDelete.id);
      }
    }

    if (duplicatesToDelete.length > 0) {
      console.warn(`[OrderService] Limpiando ${duplicatesToDelete.length} pedidos fantasmas duplicados:`, duplicatesToDelete);
      for (const id of duplicatesToDelete) {
        await storageService.delete('orders', id);
        supabaseService.pushDelete('orders', id).catch(() => {});
      }
    }

    return duplicatesToDelete;
  }

  // Búsqueda inteligente: filtra por cliente, por producto encargado o por código
  async searchOrdersAndProducts(query) {
    const orders = await this.getAllOrders();
    if (!query) return orders;

    const q = query.toLowerCase().trim();

    return orders.filter(order => {
      // Coincidencia con código de encargo
      if (order.id.toLowerCase().includes(q)) return true;
      // Coincidencia con nombre o teléfono del cliente
      if (order.clienteNombre && order.clienteNombre.toLowerCase().includes(q)) return true;
      if (order.clienteTelefono && order.clienteTelefono.toLowerCase().includes(q)) return true;
      // Coincidencia con ciudad de destino
      if (order.lugarDestino && order.lugarDestino.ciudad && order.lugarDestino.ciudad.toLowerCase().includes(q)) return true;
      // Coincidencia con productos encargados
      const matchProduct = (order.items || []).some(item => 
        item.descripcion.toLowerCase().includes(q) ||
        (item.notas && item.notas.toLowerCase().includes(q))
      );
      if (matchProduct) return true;

      return false;
    });
  }

  // Determina si un pedido está finalizado (cumple las 3 condiciones: cancelado 100%, productos adquiridos y producto entregado, o está archivado)
  isOrderFinalized(order) {
    if (!order) return false;
    if (order.archivado) return true;
    const isPaid = (order.saldoPendiente < 0.01 || (order.costoTotal > 0 && order.totalAbonado >= order.costoTotal));
    const isDelivered = Boolean(order.entregado);
    const isAcquired = Boolean(order.adquirido);
    return isPaid && isAcquired && isDelivered;
  }

  // Estadísticas para el Dashboard
  async getDashboardMetrics() {
    const orders = await this.getAllOrders();
    // Un encargo está activo en el tablero mientras no esté cancelado ni archivado
    const activeOrders = orders.filter(o => o.estado !== 'cancelado' && !o.archivado);
    const finalizedOrders = orders.filter(o => o.estado !== 'cancelado' && this.isOrderFinalized(o));

    let totalPorCobrar = 0;       // Saldo deudor global acumulado de encargos activos
    let totalRecaudado = 0;        // Total recaudado de encargos activos (deja de sumar al archivarse)
    let totalFacturado = 0;        // Valor total de encargos activos
    let pendientesAnticipoCount = 0;
    let apartadosEnAbonosCount = 0;
    let liquidadosCount = 0;
    let entregadosCount = activeOrders.filter(o => o.entregado).length;
    let adquiridosCount = activeOrders.filter(o => o.adquirido).length;

    const destinosMap = {};

    // Métricas del tablero principal: Se calculan sobre encargos activos.
    // Si ya se pagó en su totalidad, se entregó y se marcó archivar, deja de sumar en el tablero principal en recaudado.
    activeOrders.forEach(o => {
      totalRecaudado += (o.totalAbonado || 0);
      totalFacturado += (o.costoTotal || 0);
      totalPorCobrar += (o.saldoPendiente || 0);

      if (o.saldoPendiente < 0.01 && o.costoTotal > 0) liquidadosCount++;
      else if (o.totalAbonado > 0) apartadosEnAbonosCount++;
      else if (o.costoTotal > 0) pendientesAnticipoCount++; // Solo cuenta encargos con precio definido
    });

    // Agrupación por ciudad solo de envíos activos pendientes de entrega
    activeOrders.filter(o => !o.entregado).forEach(o => {
      const ciudad = (o.lugarDestino && o.lugarDestino.ciudad) ? o.lugarDestino.ciudad : 'Sin destino';
      if (!destinosMap[ciudad]) {
        destinosMap[ciudad] = { ciudad, cantidad: 0, saldoPendiente: 0, totalAbonado: 0 };
      }
      destinosMap[ciudad].cantidad++;
      destinosMap[ciudad].saldoPendiente += (o.saldoPendiente || 0);
      destinosMap[ciudad].totalAbonado += (o.totalAbonado || 0);
    });

    return {
      totalPorCobrar: Math.round(totalPorCobrar * 100) / 100,
      totalRecaudado: Math.round(totalRecaudado * 100) / 100,
      totalFacturado: Math.round(totalFacturado * 100) / 100,
      totalPedidos: activeOrders.length,
      finalizadosCount: finalizedOrders.length,
      adquiridosCount,
      entregadosCount,
      pendientesAnticipoCount,
      apartadosEnAbonosCount,
      liquidadosCount,
      destinos: Object.values(destinosMap).sort((a, b) => b.cantidad - a.cantidad)
    };
  }

  // Generar URL para abrir directamente Google Maps en modo ruta / navegación
  getMapsRouteUrl(lugarDestino) {
    if (!lugarDestino) return 'https://www.google.com/maps';

    // Si es un string simple (ej. el nombre de una ciudad)
    if (typeof lugarDestino === 'string') {
      return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(lugarDestino)}`;
    }

    // Si ya tiene link de Maps guardado directamente (ej. link compartido de WhatsApp)
    if (lugarDestino.mapsUrl && lugarDestino.mapsUrl.startsWith('http')) {
      return lugarDestino.mapsUrl;
    }

    // Si tiene coordenadas GPS exactas
    if (lugarDestino.lat && lugarDestino.lng) {
      return `https://www.google.com/maps/dir/?api=1&destination=${lugarDestino.lat},${lugarDestino.lng}`;
    }

    // Combinar dirección, punto de entrega y ciudad para la mejor precisión
    const parts = [];
    if (lugarDestino.direccion) parts.push(lugarDestino.direccion);
    if (lugarDestino.puntoEntrega) parts.push(lugarDestino.puntoEntrega);
    if (lugarDestino.ciudad) parts.push(lugarDestino.ciudad);

    const query = parts.join(', ').trim();
    if (!query) return 'https://www.google.com/maps';

    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(query)}`;
  }
}

export const orderService = new OrderService();
