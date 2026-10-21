/**
 * NotificationService - DeepSeek Harness Provider
 * Generación de mensajes y enlaces para WhatsApp y Correo Electrónico.
 */

class NotificationService {
  formatCurrency(amount, symbol = '$') {
    return `${symbol} ${Number(amount || 0).toFixed(2)}`;
  }

  // Limpiar número telefónico para formato internacional de WhatsApp (+58 Venezuela por defecto o configurable)
  cleanPhoneNumber(phone, defaultPrefix = '+58') {
    if (!phone) return '';
    const raw = String(phone).trim();
    if (!raw) return '';

    // Si comienza explícitamente con '+', el usuario ya ingresó código de país
    if (raw.startsWith('+')) {
      return raw.replace(/[^\d]/g, '');
    }

    // Limpiar caracteres no numéricos (espacios, guiones, paréntesis)
    let digits = raw.replace(/[^\d]/g, '');
    if (!digits) return '';

    // Limpiar prefijo configurado para obtener solo dígitos (ej: '+58' -> '58')
    let cleanPrefix = String(defaultPrefix || '+58').replace(/[^\d]/g, '') || '58';

    // Si empieza con '00' (marcado internacional e.g. 0058...)
    if (digits.startsWith('00')) {
      return digits.substring(2);
    }

    // Si ya empieza con el código de país y tiene longitud suficiente (ej: 584141234567 tiene 12 dígitos)
    if (digits.startsWith(cleanPrefix) && digits.length >= (cleanPrefix.length + 7)) {
      return digits;
    }

    // Si empieza con 0 (e.g. 04141234567 o 0424...), quitamos el 0 nacional de discado
    if (digits.startsWith('0')) {
      digits = digits.replace(/^0+/, '');
    }

    // Si después de quitar el 0 ya contiene el prefijo
    if (digits.startsWith(cleanPrefix) && digits.length >= (cleanPrefix.length + 7)) {
      return digits;
    }

    // Prependemos el prefijo de país configurado
    return `${cleanPrefix}${digits}`;
  }

  // Generar mensaje de WhatsApp para el encargo
  buildWhatsAppMessage(order, config) {
    const empresa = config?.empresa || {};
    const symbol = empresa.moneda || '$';
    const nombreEmpresa = empresa.nombre || 'Encargos & Apartados Express';

    let itemsList = '';
    (order.items || []).forEach((item, idx) => {
      itemsList += `  ${idx + 1}. *${item.cantidad}x ${item.descripcion}* - ${this.formatCurrency(item.cantidad * item.precioUnitario, symbol)}\n`;
      if (item.notas) itemsList += `     _(Nota: ${item.notas})_\n`;
    });

    const destino = order.lugarDestino?.ciudad || 'Por coordinar';
    const punto = order.lugarDestino?.puntoEntrega ? ` (${order.lugarDestino.puntoEntrega})` : '';
    const fecha = order.fechaEntregaEstimada ? `📅 *Fecha prevista de entrega:* ${order.fechaEntregaEstimada}\n` : '';

    let mensaje = `👋 ¡Hola *${order.clienteNombre}*!\n\n`;
    mensaje += `Te compartimos el comprobante de tu encargo en *${nombreEmpresa}*:\n\n`;
    mensaje += `📦 *Folio:* ${order.id}\n`;
    mensaje += `📍 *Ciudad de entrega:* ${destino}${punto}\n`;
    if (fecha) mensaje += `${fecha}`;
    mensaje += `\n🛒 *Productos encargados:*\n${itemsList}\n`;

    if (order.costoEnvioComision > 0) {
      mensaje += `🚚 *Comisión / Encomienda:* ${this.formatCurrency(order.costoEnvioComision, symbol)}\n`;
    }

    mensaje += `\n💰 *RESUMEN FINANCIERO:*\n`;
    mensaje += `• *Costo Total:* ${this.formatCurrency(order.costoTotal, symbol)}\n`;
    mensaje += `• *Total Abonado:* ${this.formatCurrency(order.totalAbonado, symbol)}\n`;

    if (order.saldoPendiente > 0) {
      mensaje += `• ⚠️ *SALDO PENDIENTE:* *${this.formatCurrency(order.saldoPendiente, symbol)}*\n`;
      mensaje += `_Avance de pago: ${order.porcentajePagado}% completado_\n`;
    } else {
      mensaje += `• ✅ *ESTADO:* *PAGADO / LIQUIDADO AL 100%*\n`;
    }

    // Detalle del último abono registrado si existe
    if (order.historialAbonos && order.historialAbonos.length > 0) {
      const ult = order.historialAbonos[order.historialAbonos.length - 1];
      const fechaAbono = ult.fecha ? ult.fecha.split('T')[0] : 'Reciente';
      mensaje += `\n💵 *Último Pago / Abono:* ${this.formatCurrency(ult.monto, symbol)} (${fechaAbono})\n`;
      if (ult.metodo) mensaje += `  _Método: ${ult.metodo}_\n`;
      if (ult.comprobanteRef) mensaje += `  _Referencia: ${ult.comprobanteRef}_\n`;
    }

    if (empresa.telefono) {
      mensaje += `\n📞 Consultas al: ${empresa.telefono}\n`;
    }
    mensaje += `\n${empresa.mensajeTicket || '¡Gracias por confiar en nosotros!'}`;

    return mensaje;
  }

  // Abrir WhatsApp con el mensaje precargado y número internacional validado
  openWhatsApp(order, config) {
    const defaultPrefix = config?.empresa?.prefijoPais || '+58';
    const rawPhone = order.clienteTelefono || '';
    const cleanPhone = this.cleanPhoneNumber(rawPhone, defaultPrefix);
    const text = encodeURIComponent(this.buildWhatsAppMessage(order, config));

    let url = '';
    if (cleanPhone) {
      url = `https://wa.me/${cleanPhone}?text=${text}`;
    } else {
      url = `https://wa.me/?text=${text}`;
    }

    window.open(url, '_blank');
  }

  // Abrir cliente de correo (mailto) con plantilla completa
  openEmail(order, config, customerEmail = '') {
    const empresa = config.empresa || {};
    const recipient = customerEmail || '';
    const subject = encodeURIComponent(`Comprobante de Encargo ${order.id} - ${empresa.nombre || 'Encargos Express'}`);
    const body = encodeURIComponent(this.buildWhatsAppMessage(order, config));

    const mailtoUrl = `mailto:${recipient}?subject=${subject}&body=${body}`;
    window.location.href = mailtoUrl;
  }
}

export const notificationService = new NotificationService();
