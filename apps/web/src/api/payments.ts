import { CheckoutStartResponseSchema, TransactionDetailDtoSchema } from '@leash/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiSend } from './client';

function useInvalidatePurchases() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['transactions'] }),
      queryClient.invalidateQueries({ queryKey: ['policies', 'budget'] }),
      queryClient.invalidateQueries({ queryKey: ['tasks'] }),
    ]);
}

/** Creates (or resumes) the PayPal sandbox order; returns where to send the user. */
export function useStartCheckout(transactionId: string) {
  const invalidate = useInvalidatePurchases();
  return useMutation({
    mutationFn: () =>
      apiSend(
        'POST',
        `/api/v1/transactions/${encodeURIComponent(transactionId)}/checkout`,
        undefined,
        CheckoutStartResponseSchema,
      ),
    onSettled: invalidate,
  });
}

/** After PayPal: the server verifies the order itself and captures it. */
export function useCompleteCheckout(transactionId: string) {
  const invalidate = useInvalidatePurchases();
  return useMutation({
    mutationFn: () =>
      apiSend(
        'POST',
        `/api/v1/transactions/${encodeURIComponent(transactionId)}/checkout/complete`,
        undefined,
        TransactionDetailDtoSchema,
      ),
    onSettled: invalidate,
  });
}
