/**
 * PrintService - DeepSeek Harness Provider
 * Generación e impresión de tickets térmicos (58mm / 80mm) y recibos de entrega.
 */

class PrintService {
  formatCurrency(amount, symbol = '$') {
    return `${symbol} ${Number(amount || 0).toFixed(2)}`;
  }

  formatDate(dateStr) {
    if (!dateStr) return 'N/A';
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch {
      return dateStr;
    }
  }

  generateTicketHtml(order, config) {
    const empresa = config.empresa || {};
    const symbol = empresa.moneda || '$';

    const itemsHtml = (order.items || []).map(item => `
      <div class="ticket-item">
        <div class="ticket-item-header">
          <span class="ticket-item-qty">${item.cantidad}x</span>
          <span class="ticket-item-name">${item.descripcion}</span>
          <span class="ticket-item-price">${this.formatCurrency(item.cantidad * item.precioUnitario, symbol)}</span>
        </div>
        ${item.notas ? `<div class="ticket-item-notes">${item.notas}</div>` : ''}
      </div>
    `).join('');

    const abonosHtml = (order.historialAbonos || []).map((abono, idx) => `
      <div class="ticket-row-small">
        <span>Abono #${idx + 1} (${abono.metodo || 'Efectivo'} - ${this.formatDate(abono.fecha)}):</span>
        <span>${this.formatCurrency(abono.monto, symbol)}</span>
      </div>
    `).join('');

    return `
      <div class="thermal-ticket">
        <div class="ticket-header">
          <h2 class="ticket-title">${empresa.nombre || 'Encargos & Apartados'}</h2>
          ${empresa.propietario ? `<p class="ticket-subtitle">Resp: ${empresa.propietario}</p>` : ''}
          ${empresa.telefono ? `<p class="ticket-subtitle">Tel: ${empresa.telefono}</p>` : ''}
          ${empresa.email ? `<p class="ticket-subtitle">Email: ${empresa.email}</p>` : ''}
          <div class="ticket-divider">================================</div>
          <div class="ticket-row-highlight">
            <strong>RECIBO DE ENCARGO / APARTADO</strong>
          </div>
          <div class="ticket-row">
            <span>Folio:</span>
            <strong>${order.id}</strong>
          </div>
          <div class="ticket-row">
            <span>Fecha Emisión:</span>
            <span>${this.formatDate(new Date())}</span>
          </div>
        </div>

        <div class="ticket-divider">--------------------------------</div>
        
        <div class="ticket-section">
          <div class="ticket-row">
            <span>Cliente:</span>
            <strong>${order.clienteNombre}</strong>
          </div>
          ${order.clienteTelefono ? `<div class="ticket-row"><span>Teléfono:</span><span>${order.clienteTelefono}</span></div>` : ''}
          <div class="ticket-row">
            <span>Destino:</span>
            <strong>${order.lugarDestino?.ciudad || 'N/A'}</strong>
          </div>
          ${order.lugarDestino?.puntoEntrega ? `<div class="ticket-row"><span>Punto:</span><span>${order.lugarDestino.puntoEntrega}</span></div>` : ''}
          ${order.fechaEntregaEstimada ? `<div class="ticket-row"><span>Fecha Entrega:</span><strong>${order.fechaEntregaEstimada}</strong></div>` : ''}
        </div>

        <div class="ticket-divider">--------------------------------</div>
        
        <div class="ticket-section">
          <div class="ticket-section-title">DETALLE DE PRODUCTOS</div>
          ${itemsHtml}
          ${order.costoEnvioComision > 0 ? `
            <div class="ticket-row" style="margin-top: 4px;">
              <span>Comisión de traslado / envío:</span>
              <span>${this.formatCurrency(order.costoEnvioComision, symbol)}</span>
            </div>
          ` : ''}
        </div>

        <div class="ticket-divider">================================</div>

        <div class="ticket-totals">
          <div class="ticket-row">
            <span>COSTO TOTAL:</span>
            <strong>${this.formatCurrency(order.costoTotal, symbol)}</strong>
          </div>
          <div class="ticket-row">
            <span>Total Abonado:</span>
            <span>${this.formatCurrency(order.totalAbonado, symbol)}</span>
          </div>
          <div class="ticket-row-balance ${order.saldoPendiente > 0 ? 'debt' : 'paid'}">
            <span>SALDO RESTANTE:</span>
            <strong style="font-size: 1.25em;">${this.formatCurrency(order.saldoPendiente, symbol)}</strong>
          </div>
          <div class="ticket-row-small" style="text-align: right; margin-top: 2px;">
            <span>Estado: <strong>${order.saldoPendiente === 0 ? 'LIQUIDADO AL 100%' : `${order.porcentajePagado}% CUBIERTO`}</strong></span>
          </div>
        </div>

        ${order.historialAbonos?.length > 0 ? `
          <div class="ticket-divider">--------------------------------</div>
          <div class="ticket-section">
            <div class="ticket-section-title">HISTORIAL DE ABONOS</div>
            ${abonosHtml}
          </div>
        ` : ''}

        <div class="ticket-divider">================================</div>
        <div class="ticket-footer">
          <p>${empresa.mensajeTicket || '¡Gracias por su preferencia!'}</p>
          <p class="ticket-barcode">*** ${order.id} ***</p>
        </div>
      </div>
    `;
  }

  printOrderTicket(order, config) {
    const printArea = document.getElementById('ticketPrintArea');
    if (!printArea) {
      console.error('Elemento ticketPrintArea no encontrado');
      return;
    }

    printArea.innerHTML = this.generateTicketHtml(order, config);
    window.print();
  }
}

export const printService = new PrintService();
